import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config/config';
import { generateDeleteToken, generateFileId } from '../common/ids';
import { extensionForMime, formatBytes, isScrubbable, sanitizeFilename } from '../common/mime';
import { SNIFF_BYTES, resolveMime } from '../common/sniff';
import { scrubMetadata } from '../privacy/scrub';
import { StorageService } from '../storage/storage.service';
import { FilesService } from '../files/files.service';
import { StoredFile } from '../files/file.entity';
import { candidatesFromHtml } from './extractors/opengraph';
import { extractorFor, type MediaCandidate } from './extractors';
import { RemoteFetchError, openRemote, readText, type RemoteResponse } from './http';

/**
 * The per-link privacy switches, carried through the import path so a
 * rehosted link can be burn-after-reading or passphrase-locked exactly like
 * an uploaded one. End-to-end is deliberately absent: the browser has to hold
 * the plaintext to encrypt it, and on an import it never does.
 */
export interface LinkOptions {
  maxDownloads?: number | null;
  passwordHash?: string | null;
}

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

  constructor(
    private readonly filesService: FilesService,
    private readonly storage: StorageService,
  ) {}

  async importUrl(rawUrl: string, expiryMinutes?: number, links: LinkOptions = {}): Promise<ImportResult> {
    if (this.inFlight >= config.remote.maxConcurrent) {
      throw new RemoteFetchError('Too many imports running right now — try again in a moment');
    }

    this.inFlight++;
    try {
      return await this.run(rawUrl.trim(), expiryMinutes, links);
    } finally {
      this.inFlight--;
    }
  }

  private async run(rawUrl: string, expiryMinutes?: number, links: LinkOptions = {}): Promise<ImportResult> {
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
      return this.tryCandidates(candidates, rawUrl, expiryMinutes, links);
    }

    // Otherwise: fetch it once and see what it is. A direct media link is by
    // far the common case, and this way it costs exactly one request.
    const probe = await openRemote(rawUrl);

    if (!isHtml(probe.contentType)) {
      return this.store(probe, rawUrl, 'direct link', expiryMinutes, undefined, links);
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
        return this.store(asCrawler, rawUrl, 'direct link', expiryMinutes, undefined, links);
      }

      candidates = candidatesFromHtml(
        await readText(asCrawler, config.remote.maxHtmlBytes),
        asCrawler.url,
      );
    }

    if (candidates.length === 0) {
      throw new RemoteFetchError('That page does not advertise an image or a video');
    }

    return this.tryCandidates(candidates, rawUrl, expiryMinutes, links);
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
    links: LinkOptions = {},
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

      return this.store(response, sourceUrl, candidate.label, expiryMinutes, candidate.filename, links);
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
    links: LinkOptions = {},
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
    // browser's is, and gets the same treatment — except we can do better
    // than trust it at all: the bytes are already on disk, so sniff them.
    // A CDN that labels every object application/octet-stream stops being a
    // reason for an imported image not to embed.
    const mime = resolveMime(response.contentType || undefined, await readHead(destination));

    // An imported photo carries the uploader's EXIF just as surely as one
    // picked off a phone, and rehosting it here would be a fresh copy of
    // someone's GPS trail on a domain with your name on it.
    if (config.privacy.stripMetadata && isScrubbable(mime) && size <= 64 * 1024 * 1024) {
      await scrubImportedFile(destination, mime);
    }

    const blob = await this.storage.sealInPlace(storageName);

    const file = this.filesService.create({
      id: generateFileId(),
      originalName: config.privacy.forgetFilenames
        ? `file${extensionForMime(mime)}`
        : sanitizeFilename(preferredName ?? nameFromUrl(response.url, mime)),
      mime,
      size: blob.size,
      storageName,
      deleteToken: generateDeleteToken(),
      expiryMinutes,
      sourceUrl,
      keyMaterial: blob.keyMaterial,
      digest: blob.digest,
      maxDownloads: links.maxDownloads ?? null,
      passwordHash: links.passwordHash ?? null,
    });

    // Deliberately not logging the source URL or the resulting ID — the
    // scrubbing logger would redact both anyway, and there is no reason to
    // write down who fetched what.
    this.logger.log(`imported ${formatBytes(size)} ${mime} (${via})`);

    return { file, sourceUrl, via };
  }
}

/** First bytes of a downloaded blob, for content sniffing. */
async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Same in-place scrub the upload path does; a failure leaves the original. */
async function scrubImportedFile(path: string, mime: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    const original = await handle.readFile();
    await handle.close();

    const { data, removed } = scrubMetadata(original, mime);
    if (removed > 0) await writeFile(path, data);
  } catch {
    // Keeping the metadata is a miss; losing the file is not acceptable.
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
