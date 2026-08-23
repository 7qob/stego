import {
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Res,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import type { Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { decideServing } from '../common/mime';
import { StoredFile } from './file.entity';
import { FilesService } from './files.service';
import { ViewsService } from '../views/views.service';

/**
 * Route map — the split exists because Discord treats these differently:
 *
 *   GET /f/:id  canonical share link.
 *               Media types stream raw bytes so Discord embeds them inline.
 *               Everything else gets the HTML page with OpenGraph tags.
 *   GET /v/:id  always the HTML viewer (for humans).
 *   GET /r/:id  always raw bytes.
 *   GET /d/:id  raw bytes, forced as a download.
 */
@Controller()
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly viewsService: ViewsService,
  ) {}

  @Get('f/:id')
  share(@Param('id') id: string, @Res() res: Response): void {
    const file = this.requireFile(id, res);
    if (!file) return;

    if (decideServing(file.mime).embeddable) {
      this.streamRaw(file, res, false);
      return;
    }

    this.sendHtml(res, 200, this.viewsService.renderFilePage(file));
  }

  @Get('v/:id')
  view(@Param('id') id: string, @Res() res: Response): void {
    const file = this.requireFile(id, res);
    if (!file) return;
    this.sendHtml(res, 200, this.viewsService.renderFilePage(file));
  }

  @Get('r/:id')
  raw(@Param('id') id: string, @Res() res: Response): void {
    const file = this.requireFile(id, res);
    if (!file) return;
    this.streamRaw(file, res, false);
  }

  @Get('d/:id')
  download(@Param('id') id: string, @Res() res: Response): void {
    const file = this.requireFile(id, res);
    if (!file) return;
    this.streamRaw(file, res, true);
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

  private requireFile(id: string, res: Response): StoredFile | null {
    const file = this.filesService.findById(id);
    if (!file) {
      this.sendHtml(res, 404, this.viewsService.renderNotFound());
      return null;
    }
    return file;
  }

  /**
   * res.sendFile (not StreamableFile) so Express handles Range requests —
   * without those, seeking in an uploaded video does not work.
   * Headers are passed as options because send() would otherwise guess a
   * Content-Type from the path, and our blobs are stored without extensions.
   */
  private streamRaw(file: StoredFile, res: Response, forceDownload: boolean): void {
    const serving = decideServing(file.mime);
    const disposition = forceDownload ? 'attachment' : serving.disposition;

    // RFC 5987 encoding keeps non-ASCII filenames intact.
    const encodedName = encodeURIComponent(file.originalName);

    this.filesService.recordDownload(file.id);

    res.sendFile(this.filesService.absolutePath(file), {
      acceptRanges: true,
      headers: {
        'Content-Type': serving.contentType,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedName}`,
        // Content is immutable: the ID never points at different bytes.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  private sendHtml(res: Response, status: number, html: string): void {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
