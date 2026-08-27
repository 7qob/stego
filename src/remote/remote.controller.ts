import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Logger,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { hashPassword } from '../common/ids';
import { config } from '../config/config';
import { parseExpiryMinutes } from '../files/expiry';
import { buildFileResponse, type FileResponse } from '../files/file-response';
import { RemoteFetchError } from './http';
import { RemoteService } from './remote.service';

interface ImportBody {
  url?: unknown;
  /** Delete-after timer, same field name and meaning as on /api/upload. */
  minutes?: unknown;
  /** Burn-after-reading count, same as on /api/upload. */
  maxDownloads?: unknown;
  /** Per-link passphrase, same as on /api/upload. */
  password?: unknown;
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

    const expiryMinutes = parseExpiryMinutes(body?.minutes);

    try {
      const result = await this.remoteService.importUrl(url, expiryMinutes, {
        maxDownloads: parseMaxDownloads(body?.maxDownloads),
        passwordHash: parseLinkPassword(body?.password),
      });
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

/** Same rules as the upload path; kept here so the two bodies stay identical. */
function parseMaxDownloads(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (!config.links.burnEnabled) return null;

  const count = Number(String(value).trim());
  if (!Number.isInteger(count) || count < 0) {
    throw new BadRequestException('"maxDownloads" must be a whole number, or 0 for unlimited');
  }
  if (count === 0) return null;
  if (count > 10_000) throw new BadRequestException('"maxDownloads" is unreasonably large');

  return count;
}

function parseLinkPassword(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (!config.links.passwordEnabled) return null;
  if (value.length > 512) throw new BadRequestException('That passphrase is absurdly long');

  return hashPassword(value);
}
