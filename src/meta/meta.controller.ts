import { BadRequestException, Controller, Get, Header, NotFoundException, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { decideServing, formatBytes } from '../common/mime';
import { config } from '../config/config';
import { FilesService } from '../files/files.service';

/**
 * The small endpoints that make other software work with this one: what a
 * crawler is allowed to do, what a chat client should render, and whether the
 * process is alive.
 */
@Controller()
export class MetaController {
  constructor(private readonly filesService: FilesService) {}

  /**
   * A shared link that turns up in a search result has stopped being a shared
   * link. Deny everything — including the AI crawlers, which ignore this about
   * as often as they honour it, but a stated rule is worth having.
   */
  @Get('robots.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=86400')
  robots(): string {
    if (!config.privacy.noIndex) {
      return 'User-agent: *\nDisallow: /f/\nDisallow: /v/\nDisallow: /r/\nDisallow: /d/\nDisallow: /s/\nDisallow: /u/\n';
    }

    return 'User-agent: *\nDisallow: /\n';
  }

  /** Stops browsers 404-ing on the icon and filling the log with it. */
  @Get('favicon.ico')
  favicon(@Res() res: Response): void {
    res.status(204).end();
  }

  /**
   * oEmbed. Discord reads it for the small grey line above an embed, and
   * Slack, Notion, WordPress and a pile of CMSes use it as their primary
   * source — without it they fall back to showing a bare URL.
   */
  @Get('api/oembed')
  oembed(@Query('url') url?: string, @Query('format') format?: string) {
    if (format && format !== 'json') {
      throw new BadRequestException('Only the json format is supported');
    }
    if (!url) throw new BadRequestException('Missing "url"');

    const id = idFromUrl(url);
    if (!id) throw new NotFoundException('Not an embeddable link');

    const file = this.filesService.findById(id);
    // An end-to-end or locked file has nothing to describe, and describing it
    // anyway would confirm to a scraper that the ID is real.
    if (!file || file.e2e || file.passwordHash) throw new NotFoundException('Not found');

    const serving = decideServing(file.mime);
    const raw = `${config.baseUrl}/r/${file.id}`;

    const base = {
      version: '1.0',
      provider_name: 'stego',
      provider_url: config.baseUrl,
      title: file.originalName,
      author_name: `${formatBytes(file.size)} · ${serving.contentType.split(';')[0]}`,
    };

    if (serving.contentType.startsWith('image/')) {
      return { ...base, type: 'photo', url: raw, width: 0, height: 0 };
    }

    if (serving.contentType.startsWith('video/') || serving.contentType.startsWith('audio/')) {
      return { ...base, type: 'video', html: '', width: 0, height: 0 };
    }

    return { ...base, type: 'link' };
  }

  /**
   * Liveness only. Deliberately says nothing about counts, versions or
   * configuration — this is the one endpoint an unauthenticated stranger is
   * expected to hit, so it should tell them nothing.
   */
  @Get('api/health')
  @Header('Cache-Control', 'no-store')
  health(): { ok: true } {
    return { ok: true };
  }
}

/** Pulls the file ID out of any of the share URL shapes. */
function idFromUrl(url: string): string | null {
  const match = /\/(?:f|v|r|d|s)\/([A-Za-z0-9_-]{4,64})(?:[/?#]|$)/.exec(url);
  return match ? match[1] : null;
}
