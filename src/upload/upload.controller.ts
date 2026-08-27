import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { diskStorage } from 'multer';
import { randomBytes } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config/config';
import { generateDeleteToken, generateFileId, hashPassword } from '../common/ids';
import { extensionForMime, isScrubbable, sanitizeFilename } from '../common/mime';
import { SNIFF_BYTES, resolveMime } from '../common/sniff';
import { buildFileResponse } from '../files/file-response';
import { parseExpiryMinutes } from '../files/expiry';
import { FilesService } from '../files/files.service';
import { clientKey } from '../privacy/client-id';
import { RateLimitService } from '../privacy/rate-limit';
import { scrubMetadata } from '../privacy/scrub';
import { StorageService } from '../storage/storage.service';

/**
 * Uploads stream straight to disk. memoryStorage would buffer the entire file
 * in RAM before touching the filesystem — on a Pi, a couple of concurrent
 * large uploads would be enough to OOM the process.
 */
const storage = diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  // Blob names are random and extensionless. The original name lives in
  // SQLite only, so a crafted filename can never influence a path we build.
  filename: (_req, _file, cb) => cb(null, randomBytes(16).toString('hex')),
});

@Controller('api')
export class UploadController {
  constructor(
    private readonly filesService: FilesService,
    private readonly storageService: StorageService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get('limits')
  limits() {
    return {
      maxFileSize: config.maxFileSize,
      retentionDays: config.retentionMs > 0 ? config.retentionMs / 86_400_000 : null,
      defaultExpiryMinutes: config.expiry.defaultMinutes,
      maxExpiryMinutes: config.expiry.maxMinutes,
      importEnabled: config.remote.enabled,
      maxImportSize: config.remote.enabled ? config.remote.maxBytes : null,
      // What the UI should offer. Each of these is independently switchable
      // so an instance can be as plain or as paranoid as its operator wants.
      burnEnabled: config.links.burnEnabled,
      passwordEnabled: config.links.passwordEnabled,
      e2eEnabled: config.links.e2eEnabled,
      stripMetadata: config.privacy.stripMetadata,
      encryptAtRest: config.privacy.encryptAtRest,
    };
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage,
      limits: { fileSize: config.maxFileSize, files: 1 },
    }),
  )
  async upload(
    @Req() req: Request,
    @Body('minutes') minutes?: string,
    @Body('maxDownloads') maxDownloads?: string,
    @Body('password') password?: string,
    @Body('e2e') e2e?: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const client = clientKey(req);
    if (!this.rateLimit.take('upload', client)) {
      // Clean up the blob multer already wrote before rejecting.
      if (file) await this.storageService.remove(file.filename);
      throw new HttpException(
        { message: 'Too many uploads from here. Try again in a minute.' },
        429,
      );
    }

    if (!file) throw new BadRequestException('No file provided (field name must be "file")');

    try {
      return await this.ingest(file, { minutes, maxDownloads, password, e2e });
    } catch (error) {
      // Never leave a blob behind when the row was not written.
      await this.storageService.remove(file.filename);
      throw error;
    }
  }

  private async ingest(
    file: Express.Multer.File,
    options: {
      minutes?: string;
      maxDownloads?: string;
      password?: string;
      e2e?: string;
    },
  ) {
    // Multer fills req.body as it walks the stream, so these are only here if
    // the client appended them ahead of the file part. Missing means default.
    const expiryMinutes = parseExpiryMinutes(options.minutes);
    const isE2e = options.e2e === '1' || options.e2e === 'true';

    if (isE2e && !config.links.e2eEnabled) {
      throw new BadRequestException('End-to-end links are disabled on this instance');
    }

    const path = join(config.uploadDir, file.filename);

    /**
     * End-to-end uploads are ciphertext the browser produced. There is nothing
     * to sniff, nothing to scrub, and the filename was encrypted along with
     * the bytes — so all of that is skipped and the row records a neutral
     * placeholder. This is the one path where the server genuinely holds no
     * information about what it is storing.
     */
    const mime = isE2e
      ? 'application/octet-stream'
      : resolveMime(file.mimetype, await readHead(path));

    const originalName = isE2e
      ? 'encrypted.bin'
      : config.privacy.forgetFilenames
        ? `file${extensionForMime(mime)}`
        : sanitizeFilename(file.originalname);

    // Strip EXIF/XMP/IPTC before anything is sealed or served. Container-level
    // only — see privacy/scrub.ts for why re-encoding is not an option here.
    if (!isE2e && config.privacy.stripMetadata && isScrubbable(mime) && file.size <= 64 * 1024 * 1024) {
      await this.scrubInPlace(path, mime);
    }

    const blob = await this.storageService.sealInPlace(file.filename);

    const stored = this.filesService.create({
      id: generateFileId(),
      originalName,
      mime,
      size: blob.size,
      storageName: blob.storageName,
      deleteToken: generateDeleteToken(),
      expiryMinutes,
      keyMaterial: blob.keyMaterial,
      digest: blob.digest,
      maxDownloads: parseMaxDownloads(options.maxDownloads),
      passwordHash: parseLinkPassword(options.password),
      e2e: isE2e,
    });

    return buildFileResponse(stored);
  }

  /**
   * Reads the file, scrubs it, writes it back only if something changed.
   * Bounded by the size check at the call site because this is the one step
   * that needs the whole image in memory.
   */
  private async scrubInPlace(path: string, mime: string): Promise<void> {
    try {
      const handle = await open(path, 'r');
      const original = await handle.readFile();
      await handle.close();

      const { data, removed } = scrubMetadata(original, mime);
      if (removed > 0) await writeFile(path, data);
    } catch {
      // A scrub that fails leaves the original in place. Keeping the metadata
      // is a miss; losing the file is not an acceptable way to fail.
    }
  }
}

/** First bytes of the stored blob, for content sniffing. */
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

/** Burn-after-reading count. Absent, empty or 0 means no limit. */
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
