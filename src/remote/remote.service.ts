import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config/config';
import { generateDeleteToken, generateFileId } from '../common/ids';
import { extensionForMime, formatBytes, sanitizeFilename } from '../common/mime';
import { FilesService } from '../files/files.service';
import { StoredFile } from '../files/file.entity';
import { candidatesFromHtml } from './extractors/opengraph';
import { extractorFor, type MediaCandidate } from './extractors';
import { RemoteFetchError, openRemote, readText, type RemoteResponse } from './http';

export interface ImportResult {
  file: StoredFile;
  /** The link the user pasted. */
  sourceUrl: string;
  /** How we got from that link to these bytes, e.g. "og:image". */
  via: string;
}

function isHtml(contentType: string): boolean {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

/** Best-effort filename from the URL we actually downloaded. */
function nameFromUrl(rawUrl: string, mime: string): string {
  let base = '';
  try {
    base = decodeURIComponent(new URL(rawUrl).pathname.split('/').pop() ?? '');
  } catch {
    base = '';
  }

  base = base.trim();
  if (!base) base = 'download';
  if (!/\.[a-z0-9]{1,8}$/i.test(base)) base += extensionForMime(mime);

  return base;
}

@Injectable()
export class RemoteService {
  private readonly logger = new Logger(RemoteService.name);

  /**
   * Every import is an outbound transfer paid for by the household uplink, and
   * nothing else in the app throttles anything yet. A hard ceiling on
   * in-flight imports is the cheap half of the rate limiting this still needs.
   */
  private inFlight = 0;

  constructor(private readonly filesService: FilesService) {}

  async importUrl(rawUrl: string, expiryMinutes?: number): Promise<ImportResult> {
    if (this.inFlight >= config.remote.maxConcurrent) {
      throw new RemoteFetchError('Too many imports running right now — try again in a moment');
    }

    this.inFlight++;
    try {
      return await this.run(rawUrl.trim(), expiryMinutes);
    } finally {
      this.inFlight--;
    }
  }

  private async run(rawUrl: string, expiryMinutes?: number): Promise<ImportResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new RemoteFetchError('That does not look like a URL');
    }

    // A site the generic scrape cannot handle (client-rendered pages, mostly).
    const site = extractorFor(url);
    if (site) {
      const candidates = await site.resolve(url);
      return this.tryCandidates(candidates, rawUrl, expiryMinutes);
    }

    // Otherwise: fetch it once and see what it is. A direct media link is by
    // far the common case, and this way it costs exactly one request.
    const probe = await openRemote(rawUrl);

    if (!isHtml(probe.contentType)) {
      return this.store(probe, rawUrl, 'direct link', expiryMinutes);
    }

    const html = await readText(probe, config.remote.maxHtmlBytes);
    let candidates = candidatesFromHtml(html, probe.url);

    if (candidates.length === 0) {
      // Ask again as a scraper. This is not a trick so much as the intended
      // path: sites gate their OpenGraph tags behind a crawler User-Agent
      // precisely so that link-unfurlers can read them, and unfurling is
      // exactly what we are doing.
      const asCrawler = await openRemote(probe.url, {
        headers: { 'user-agent': config.remote.crawlerUserAgent },
      });

      if (!isHtml(asCrawler.contentType)) {
        return this.store(asCrawler, rawUrl, 'direct link', expiryMinutes);
      }

      candidates = candidatesFromHtml(
        await readText(asCrawler, config.remote.maxHtmlBytes),
        asCrawler.url,
      );
    }

    if (candidates.length === 0) {
      throw new RemoteFetchError('That page does not advertise an image or a video');
    }

    return this.tryCandidates(candidates, rawUrl, expiryMinutes);
  }

  /**
   * Walks the candidate list until something yields real bytes. Candidates
   * that turn out to be HTML are skipped rather than fatal — `og:video` is
   * frequently an embed *page*, and the page's `og:image` right behind it in
   * the list is a perfectly good import.
   */
  private async tryCandidates(
    candidates: MediaCandidate[],
    sourceUrl: string,
    expiryMinutes?: number,
  ): Promise<ImportResult> {
    const problems: string[] = [];

    for (const candidate of candidates) {
      let response: RemoteResponse;
      try {
        response = await openRemote(candidate.url, { headers: candidate.headers });
      } catch (error) {
        problems.push(`${candidate.label}: ${(error as Error).message}`);
        continue;
      }

      if (isHtml(response.contentType)) {
        response.body.destroy();
        problems.push(`${candidate.label}: a web page, not a file`);
        continue;
      }

      return this.store(response, sourceUrl, candidate.label, expiryMinutes, candidate.filename);
    }

    throw new RemoteFetchError(
      `Could not import anything from that link — ${problems.join('; ') || 'no usable media'}`,
    );
  }

  private async store(
    response: RemoteResponse,
    sourceUrl: string,
    via: string,
    expiryMinutes?: number,
    preferredName?: string,
  ): Promise<ImportResult> {
    const limit = config.remote.maxBytes;

    if (response.contentLength !== null && response.contentLength > limit) {
      response.body.destroy();
      throw new RemoteFetchError(
        `That file is ${formatBytes(response.contentLength)}; the limit is ${formatBytes(limit)}`,
      );
    }

    // Same rules as an upload: random extensionless blob name, and the
    // original name is metadata only, never part of a path we build.
    const storageName = randomBytes(16).toString('hex');
    const destination = join(config.uploadDir, storageName);

    let size: number;
    try {
      size = await streamToFile(response, destination, limit);
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }

    if (size === 0) {
      await unlink(destination).catch(() => undefined);
      throw new RemoteFetchError('The source returned an empty file');
    }

    // The remote server's Content-Type is untrusted in exactly the way a
    // browser's is, and gets the same treatment: common/mime.ts decides what
    // we are willing to serve it as, everything else becomes an attachment.
    const mime = response.contentType || 'application/octet-stream';

    const file = this.filesService.create({
      id: generateFileId(),
      originalName: sanitizeFilename(preferredName ?? nameFromUrl(response.url, mime)),
      mime,
      size,
      storageName,
      deleteToken: generateDeleteToken(),
      expiryMinutes,
      sourceUrl,
    });

    this.logger.log(`imported ${formatBytes(size)} ${mime} from ${sourceUrl} (${via}) as ${file.id}`);

    return { file, sourceUrl, via };
  }
}

/** Streams a response to disk, aborting the moment it exceeds the cap. */
async function streamToFile(
  response: RemoteResponse,
  destination: string,
  maxBytes: number,
): Promise<number> {
  let total = 0;

  // A Content-Length can lie, or be absent on a chunked response, so the real
  // enforcement is here — counted as the bytes land, not before.
  async function* capped(): AsyncGenerator<Buffer> {
    for await (const chunk of response.body) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) {
        throw new RemoteFetchError(`Source exceeded the ${formatBytes(maxBytes)} limit`);
      }
      yield chunk as Buffer;
    }
  }

  // `wx` — the blob name is freshly random, so an existing file would mean a
  // collision we would rather hear about than silently overwrite.
  await pipeline(capped(), createWriteStream(destination, { flags: 'wx' }));

  return total;
}
