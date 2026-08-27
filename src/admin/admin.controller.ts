import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { decideServing } from '../common/mime';
import { config } from '../config/config';
import { StoredFile, readsRemaining } from '../files/file.entity';
import { FilesService } from '../files/files.service';
import { clientKey } from '../privacy/client-id';
import { RateLimitService } from '../privacy/rate-limit';
import { AdminAuthService } from './admin.auth';
import { AdminGuard } from './admin.guard';
import { AdminViewsService } from './admin.views';

/**
 * The admin panel.
 *
 * Mounted at `config.admin.path` (default `/admin`, movable), which is why
 * every route here is registered on a controller with a runtime prefix rather
 * than a literal one.
 */
@Controller()
export class AdminController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly files: FilesService,
    private readonly views: AdminViewsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /* Pages -------------------------------------------------------------- */

  @Get('__admin')
  page(@Req() req: Request, @Res() res: Response): void {
    if (!this.auth.isEnabled()) throw new NotFoundException();

    const html = this.auth.isAuthenticated(req)
      ? this.views.renderPanel(this.auth.csrfToken(req))
      : this.views.renderLogin(false);

    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // The panel lists filenames and IDs. It must never sit in a shared cache
    // or a back-button history entry after a logout.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(html);
  }

  /** The panel's script. Served from here so it 404s when admin is off. */
  @Get('__admin/panel.js')
  script(@Res() res: Response): void {
    if (!this.auth.isEnabled()) throw new NotFoundException();

    res.status(200);
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(this.views.panelScript());
  }

  @Post('__admin/login')
  @HttpCode(200)
  login(
    @Body('password') password: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    if (!this.auth.isEnabled()) throw new NotFoundException();

    const client = clientKey(req);
    const allowed = this.rateLimit.take('login', client);

    const token = allowed && password ? this.auth.login(password, client, res) : null;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    if (!token) {
      res.status(401).send(this.views.renderLogin(true));
      return;
    }

    res.redirect(302, config.admin.path);
  }

  @Post('__admin/logout')
  @HttpCode(204)
  logout(@Req() req: Request, @Res() res: Response): void {
    if (!this.auth.isEnabled()) throw new NotFoundException();
    // Deliberately not behind AdminGuard's CSRF check: being logged out
    // against your will is not an attack worth defending against, and a
    // stale CSRF token should never be able to trap someone in a session.
    this.auth.logout(req, res);
    res.end();
  }

  /* API ---------------------------------------------------------------- */

  @Get('__admin/api/overview')
  @UseGuards(AdminGuard)
  overview() {
    return {
      stats: this.files.stats(),
      tags: this.files.tagCloud(),
      sessions: this.auth.sessionCount(),
      config: {
        adminPath: config.admin.path,
        encryptAtRest: config.privacy.encryptAtRest,
        stripMetadata: config.privacy.stripMetadata,
        forgetFilenames: config.privacy.forgetFilenames,
        noIndex: config.privacy.noIndex,
        rateLimit: config.rateLimit.enabled,
        padToBytes: config.privacy.padToBytes,
        maxFileSize: config.maxFileSize,
        defaultExpiryMinutes: config.expiry.defaultMinutes,
        retentionDays: config.retentionMs > 0 ? config.retentionMs / 86_400_000 : null,
        baseUrl: config.baseUrl,
      },
    };
  }

  @Get('__admin/api/files')
  @UseGuards(AdminGuard)
  list(
    @Query('search') search?: string,
    @Query('tag') tag?: string,
    @Query('scope') scope?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = this.files.list({
      search: search?.trim() || undefined,
      tag: tag?.trim() || undefined,
      scope: scope === 'library' || scope === 'transient' ? scope : 'all',
      sort:
        sort === 'oldest' || sort === 'largest' || sort === 'downloads'
          ? sort
          : 'newest',
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });

    return {
      total: result.total,
      items: result.items.map((file) => this.present(file)),
    };
  }

  @Get('__admin/api/files/:id')
  @UseGuards(AdminGuard)
  detail(@Param('id') id: string) {
    const file = this.files.findById(id);
    if (!file) throw new NotFoundException('File not found');

    return {
      ...this.present(file),
      // The delete token is the uploader's, and the admin can already delete
      // anything — but having it means being able to hand back a working
      // delete link rather than doing it for them.
      deleteToken: file.deleteToken,
      digest: file.digest,
      duplicates: file.digest
        ? this.files.findByDigest(file.digest).filter((other) => other.id !== file.id).map((other) => other.id)
        : [],
    };
  }

  @Delete('__admin/api/files/:id')
  @UseGuards(AdminGuard)
  async remove(@Param('id') id: string): Promise<{ deleted: boolean }> {
    return { deleted: await this.files.delete(id) };
  }

  /** Pin into the library, which also clears the expiry. */
  @Post('__admin/api/files/:id/library')
  @UseGuards(AdminGuard)
  library(@Param('id') id: string, @Body('inLibrary') inLibrary: unknown) {
    const file = this.files.setLibrary(id, inLibrary !== false);
    if (!file) throw new NotFoundException('File not found');
    return this.present(file);
  }

  @Post('__admin/api/files/:id/meta')
  @UseGuards(AdminGuard)
  meta(
    @Param('id') id: string,
    @Body('label') label?: string | null,
    @Body('tags') tags?: string | string[],
    @Body('note') note?: string | null,
  ) {
    const file = this.files.updateMeta(id, {
      ...(label !== undefined ? { label } : {}),
      ...(tags !== undefined
        ? { tags: Array.isArray(tags) ? tags : String(tags).split(',') }
        : {}),
      ...(note !== undefined ? { note } : {}),
    });

    if (!file) throw new NotFoundException('File not found');
    return this.present(file);
  }

  @Post('__admin/api/files/:id/expiry')
  @UseGuards(AdminGuard)
  expiry(@Param('id') id: string, @Body('minutes') minutes: unknown) {
    const parsed =
      minutes === null || minutes === '' || minutes === undefined ? null : Number(minutes);

    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
      throw new NotFoundException('minutes must be a whole number or null');
    }

    const file = this.files.setExpiry(id, parsed);
    if (!file) throw new NotFoundException('File not found');
    return this.present(file);
  }

  /** Recompute the stored digest against what is actually on disk. */
  @Post('__admin/api/files/:id/verify')
  @UseGuards(AdminGuard)
  async verify(@Param('id') id: string): Promise<{ status: string }> {
    return { status: await this.files.verifyIntegrity(id) };
  }

  /** Deletes everything not pinned into the library. */
  @Post('__admin/api/purge')
  @UseGuards(AdminGuard)
  async purge(@Body('confirm') confirm: unknown): Promise<{ removed: number }> {
    if (confirm !== 'PURGE') throw new NotFoundException('Confirmation phrase required');
    return { removed: await this.files.purgeAllTransient() };
  }

  @Post('__admin/api/sessions/revoke')
  @UseGuards(AdminGuard)
  @HttpCode(204)
  revoke(@Res() res: Response): void {
    this.auth.logoutEverywhere(res);
    res.end();
  }

  /** The shape the panel renders. Keeps the hash and the token out of lists. */
  private present(file: StoredFile) {
    const serving = decideServing(file.mime);

    return {
      id: file.id,
      name: file.originalName,
      mime: file.mime,
      servedAs: serving.contentType,
      size: file.size,
      createdAt: file.createdAt,
      expiresAt: file.expiresAt,
      lastSeenAt: file.lastSeenAt,
      downloads: file.downloads,
      readsRemaining: readsRemaining(file),
      locked: file.passwordHash !== null,
      e2e: file.e2e,
      encrypted: file.keyMaterial !== null,
      embeddable: serving.embeddable && !file.e2e,
      inLibrary: file.inLibrary,
      label: file.label,
      tags: file.tags,
      note: file.note,
      sourceUrl: file.sourceUrl,
      url: `${config.baseUrl}/${file.e2e ? 's' : 'f'}/${file.id}`,
      rawUrl: `${config.baseUrl}/r/${file.id}`,
    };
  }
}
