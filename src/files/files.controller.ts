import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Head,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { constantTimeEquals, verifyPassword } from '../common/ids';
import { decideServing } from '../common/mime';
import { config } from '../config/config';
import { clientKey } from '../privacy/client-id';
import { RateLimitService } from '../privacy/rate-limit';
import { StorageService } from '../storage/storage.service';
import { ViewsService } from '../views/views.service';
import { UnlockService } from './unlock.service';
import { StoredFile, isPrivateLink } from './file.entity';
import { FilesService } from './files.service';

/**
 * Route map — the split exists because Discord treats these differently:
 *
 *   GET /f/:id  canonical share link.
 *               Media types stream raw bytes so Discord embeds them inline.
 *               Everything else gets the HTML page with OpenGraph tags.
 *   GET /v/:id  always the HTML viewer (for humans).
 *   GET /r/:id  always raw bytes.
 *   GET /d/:id  raw bytes, forced as a download.
 *   GET /s/:id  the end-to-end viewer. Serves a page that decrypts in the
 *               browser using a key it reads from the URL fragment — which is
 *               why this route can never be an embed: fragments are not sent
 *               to servers, so there is nothing for a scraper to fetch.
 *   GET /u/:id  the unlock prompt for a passphrase-protected link.
 */
@Controller()
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly viewsService: ViewsService,
    private readonly storage: StorageService,
    private readonly unlock: UnlockService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get('f/:id')
  async share(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.gate(id, req, res);
    if (!file) return;

    // An end-to-end file is ciphertext. Never hand it to a scraper as media.
    if (file.e2e) {
      this.sendHtml(res, 200, this.viewsService.renderE2ePage(file), file);
      return;
    }

    if (decideServing(file.mime).embeddable) {
      await this.streamRaw(file, req, res, false);
      return;
    }

    this.sendHtml(res, 200, this.viewsService.renderFilePage(file), file);
  }

  @Get('v/:id')
  async view(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.gate(id, req, res);
    if (!file) return;

    const html = file.e2e
      ? this.viewsService.renderE2ePage(file)
      : this.viewsService.renderFilePage(file);
    this.sendHtml(res, 200, html, file);
  }

  @Get('s/:id')
  async secret(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.gate(id, req, res);
    if (!file) return;
    this.sendHtml(res, 200, this.viewsService.renderE2ePage(file), file);
  }

  @Get('r/:id')
  async raw(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.gate(id, req, res);
    if (!file) return;
    await this.streamRaw(file, req, res, false);
  }

  @Get('d/:id')
  async download(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.gate(id, req, res);
    if (!file) return;
    await this.streamRaw(file, req, res, true);
  }

  /**
   * HEAD is what curl -I, wget, most download managers and a few chat clients
   * do before fetching. Answering it with the real headers and no body means
   * they stop guessing at the size and the type.
   *
   * It deliberately does not count as a download: a HEAD that burned a
   * one-shot link would be a nasty surprise.
   */
  @Head('r/:id')
  @Head('f/:id')
  @Head('d/:id')
  async head(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.gate(id, req, res, { silent: true });
    if (!file) {
      res.status(404).end();
      return;
    }

    const serving = decideServing(file.mime);
    res.setHeader('Content-Type', serving.contentType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', this.etagFor(file));
    this.applyCachePolicy(res, file);
    res.status(200).end();
  }

  /** The unlock prompt for a passphrase-protected link. */
  @Get('u/:id')
  unlockPage(@Param('id') id: string, @Res() res: Response): void {
    const file = this.filesService.findById(id);
    if (!file || !file.passwordHash) {
      this.sendHtml(res, 404, this.viewsService.renderNotFound(), null);
      return;
    }

    this.sendHtml(res, 200, this.viewsService.renderUnlockPage(id, false), null);
  }

  @Post('u/:id')
  @HttpCode(200)
  unlockSubmit(
    @Param('id') id: string,
    @Body('password') password: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const client = clientKey(req);
    if (!this.rateLimit.take('login', client)) {
      res.setHeader('Retry-After', String(this.rateLimit.retryAfter('login', client)));
      this.sendHtml(res, 429, this.viewsService.renderUnlockPage(id, true), null);
      return;
    }

    const file = this.filesService.findById(id);
    if (!file || !file.passwordHash) {
      this.sendHtml(res, 404, this.viewsService.renderNotFound(), null);
      return;
    }

    if (!password || !verifyPassword(password, file.passwordHash)) {
      this.sendHtml(res, 401, this.viewsService.renderUnlockPage(id, true), null);
      return;
    }

    this.unlock.grant(res, id);
    res.redirect(302, `/f/${encodeURIComponent(id)}`);
  }

  @Delete('api/files/:id')
  async remove(
    @Param('id') id: string,
    @Query('token') token?: string,
  ): Promise<{ deleted: true }> {
    const file = this.filesService.findById(id);
    if (!file) throw new NotFoundException('File not found');
    if (!token || !constantTimeEquals(token, file.deleteToken)) {
      throw new ForbiddenException('Invalid delete token');
    }

    await this.filesService.delete(id);
    return { deleted: true };
  }

  /**
   * Everything a read has to pass before any bytes move: rate limit, does it
   * exist, and is it locked.
   *
   * A miss and a lockout both render the same 404 page a genuinely-absent file
   * gets. Distinguishing "no such file" from "wrong password" would turn the
   * unlock prompt into an oracle for which IDs are real.
   */
  private async gate(
    id: string,
    req: Request,
    res: Response,
    options: { silent?: boolean } = {},
  ): Promise<StoredFile | null> {
    const client = clientKey(req);

    if (!this.rateLimit.take('read', client)) {
      this.tooMany(res, client, 'read', options.silent);
      return null;
    }

    const file = this.filesService.findById(id);

    if (!file) {
      // Misses are counted separately and much more tightly: a stream of them
      // from one client is someone walking the ID space.
      if (!this.rateLimit.take('miss', client)) {
        this.tooMany(res, client, 'miss', options.silent);
        return null;
      }
      if (!options.silent) this.sendHtml(res, 404, this.viewsService.renderNotFound(), null);
      return null;
    }

    if (file.passwordHash && !this.unlock.isUnlocked(req, id)) {
      if (options.silent) return null;
      // 401 rather than a redirect so a scraper does not follow it and
      // cache the unlock page as the file's preview.
      this.sendHtml(res, 401, this.viewsService.renderUnlockPage(id, false), null);
      return null;
    }

    return file;
  }

  private tooMany(res: Response, client: string, bucket: 'read' | 'miss', silent?: boolean): void {
    res.setHeader('Retry-After', String(this.rateLimit.retryAfter(bucket, client)));
    if (silent) {
      res.status(429).end();
      return;
    }
    this.sendHtml(res, 429, this.viewsService.renderTooMany(), null);
  }

  /**
   * Streams plaintext out of the (possibly encrypted) blob, honouring Range.
   *
   * The old implementation handed this to `res.sendFile`, which cannot work
   * once the bytes on disk are ciphertext — so Range parsing lives here now.
   * Getting it right matters more than it sounds: without 206 support, seeking
   * in a video does not work and Safari refuses to play one at all.
   */
  private async streamRaw(
    file: StoredFile,
    req: Request,
    res: Response,
    forceDownload: boolean,
  ): Promise<void> {
    const serving = decideServing(file.mime);
    const disposition = forceDownload ? 'attachment' : serving.disposition;

    // RFC 5987 encoding keeps non-ASCII filenames intact. The ASCII fallback
    // is for the handful of clients that ignore filename* entirely.
    const encodedName = encodeURIComponent(file.originalName);
    const asciiName = file.originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');

    const range = parseRange(req.headers.range, file.size);

    if (range === 'unsatisfiable') {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${file.size}`);
      res.end();
      return;
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, file.size - 1);
    const length = file.size === 0 ? 0 : end - start + 1;

    res.setHeader('Content-Type', serving.contentType);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    );
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(length));
    res.setHeader('ETag', this.etagFor(file));
    res.setHeader('Last-Modified', new Date(file.createdAt).toUTCString());
    this.applyCachePolicy(res, file);

    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
    } else {
      res.status(200);
    }

    // A conditional request that already has the bytes: 304 and stop. Saves a
    // home uplink from re-sending a video every time someone reloads.
    if (!range && this.notModified(req, file)) {
      res.status(304);
      res.removeHeader('Content-Length');
      res.end();
      return;
    }

    if (file.size === 0) {
      res.end();
      return;
    }

    // Counted before the stream, so a client that disconnects halfway through
    // a one-shot link still burns it. The alternative lets someone read the
    // first byte repeatedly and never spend the read.
    const { burned } = range && start > 0
      ? { burned: false } // continuation of a read already counted
      : this.filesService.recordDownload(file.id);

    const stream = this.storage.readRange(file.storageName, file.keyMaterial, start, end);

    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });

    res.on('close', () => stream.destroy());

    stream.pipe(res);

    if (burned) {
      // Delete once the bytes are on their way out. Waiting for 'finish'
      // rather than doing it immediately means the in-flight response still
      // completes; the row is gone for everyone who asks next.
      res.on('finish', () => {
        void this.filesService.delete(file.id);
      });
    }
  }

  /**
   * Caching, and the one thing about it that actually matters here.
   *
   * The original code sent `max-age=31536000, immutable` on everything. That
   * is correct for content that never changes and catastrophic for content
   * that is supposed to disappear: a file set to delete after five minutes
   * stayed in the browser cache, and in Cloudflare's edge cache, for a year
   * after this server deleted it. "Delete after N minutes" has to mean the
   * copies stop being served too, so the max-age is capped at whatever is
   * left of the TTL.
   *
   * Private links skip the shared cache entirely — a burn-after-reading link
   * cached at an edge node is not burnt.
   */
  private applyCachePolicy(res: Response, file: StoredFile): void {
    if (config.privacy.noIndex) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
    }

    if (isPrivateLink(file)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      return;
    }

    if (file.expiresAt === null) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return;
    }

    const secondsLeft = Math.max(0, Math.floor((file.expiresAt - Date.now()) / 1000));
    res.setHeader('Cache-Control', `public, max-age=${secondsLeft}, must-revalidate`);
    res.setHeader('Expires', new Date(file.expiresAt).toUTCString());
  }

  /** Strong ETag over identity plus size; blobs are immutable per ID. */
  private etagFor(file: StoredFile): string {
    return `"${file.id}-${file.size}"`;
  }

  private notModified(req: Request, file: StoredFile): boolean {
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((tag) => tag.trim() === this.etagFor(file))) return true;

    const ims = req.headers['if-modified-since'];
    if (ims) {
      const since = Date.parse(ims);
      // Second precision on both sides, or a file created mid-second looks new.
      if (Number.isFinite(since) && Math.floor(file.createdAt / 1000) * 1000 <= since) return true;
    }

    return false;
  }

  private sendHtml(res: Response, status: number, html: string, file: StoredFile | null): void {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (file) {
      this.applyCachePolicy(res, file);
    } else {
      res.setHeader('Cache-Control', 'no-store');
      if (config.privacy.noIndex) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
      }
    }

    res.send(html);
  }
}

/**
 * Single-range `bytes=` parsing. Multi-range requests are answered with the
 * whole file, which is legal and is what most servers do — assembling a
 * multipart/byteranges body buys nothing for media playback, which only ever
 * asks for one range.
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || size === 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, startText, endText] = match;

  if (startText === '' && endText === '') return null;

  // `bytes=-500` means the last 500 bytes.
  if (startText === '') {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(startText);
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable';

  const end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';

  return { start, end };
}
