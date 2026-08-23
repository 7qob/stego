import {
  BadRequestException,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomBytes } from 'node:crypto';
import { config } from '../config/config';
import { generateDeleteToken, generateFileId } from '../common/ids';
import { sanitizeFilename } from '../common/mime';
import { buildFileResponse } from '../files/file-response';
import { FilesService } from '../files/files.service';

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
  constructor(private readonly filesService: FilesService) {}

  @Get('limits')
  limits() {
    return {
      maxFileSize: config.maxFileSize,
      retentionDays: config.retentionMs > 0 ? config.retentionMs / 86_400_000 : null,
      importEnabled: config.remote.enabled,
      maxImportSize: config.remote.enabled ? config.remote.maxBytes : null,
    };
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage,
      limits: { fileSize: config.maxFileSize, files: 1 },
    }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file provided (field name must be "file")');

    const id = generateFileId();
    const originalName = sanitizeFilename(file.originalname);

    // The browser-supplied mimetype is untrusted, and that is fine: anything
    // outside the allowlist in common/mime.ts is downgraded to an
    // octet-stream attachment, and every response carries `nosniff`, so a
    // mislabelled HTML payload can never be parsed as HTML on our origin.
    const stored = this.filesService.create({
      id,
      originalName,
      mime: file.mimetype || 'application/octet-stream',
      size: file.size,
      storageName: file.filename,
      deleteToken: generateDeleteToken(),
    });

    return buildFileResponse(stored);
  }
}
