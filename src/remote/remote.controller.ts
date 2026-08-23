import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Logger,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { config } from '../config/config';
import { buildFileResponse, type FileResponse } from '../files/file-response';
import { RemoteFetchError } from './http';
import { RemoteService } from './remote.service';

interface ImportBody {
  url?: unknown;
}

/**
 * `POST /api/import { "url": "https://…" }` — the paste-a-link counterpart to
 * `POST /api/upload`. Returns the identical body, so anything that consumes
 * one consumes the other.
 */
@Controller('api')
export class RemoteController {
  private readonly logger = new Logger(RemoteController.name);

  constructor(private readonly remoteService: RemoteService) {}

  @Post('import')
  async import(@Body() body: ImportBody): Promise<FileResponse> {
    if (!config.remote.enabled) {
      throw new ServiceUnavailableException('URL import is disabled on this instance');
    }

    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!url) throw new BadRequestException('No URL provided (send {"url": "https://…"})');
    if (url.length > 2048) throw new BadRequestException('That URL is absurdly long');

    try {
      const result = await this.remoteService.importUrl(url);
      return buildFileResponse(result.file, result.via);
    } catch (error) {
      if (error instanceof HttpException) throw error;

      // Everything the fetcher raises is already phrased for a human, and
      // saying "resolves to a private address" out loud is the point — it
      // tells an honest user why their LAN link was refused without leaking
      // anything an attacker could not learn by trying.
      if (error instanceof RemoteFetchError) throw new BadRequestException(error.message);

      this.logger.error(`import of ${url} failed: ${String(error)}`);
      throw new BadRequestException('Could not import that link');
    }
  }
}
