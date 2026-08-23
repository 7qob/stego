import { Injectable, Logger } from '@nestjs/common';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config/config';
import { DbService } from '../db/db.service';
import { FileRow, StoredFile, toStoredFile } from './file.entity';

export interface CreateFileInput {
  id: string;
  originalName: string;
  mime: string;
  size: number;
  storageName: string;
  deleteToken: string;
  /** Where the bytes came from, when they were imported rather than uploaded. */
  sourceUrl?: string | null;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(private readonly dbService: DbService) {}

  create(input: CreateFileInput): StoredFile {
    const now = Date.now();
    const expiresAt = config.retentionMs > 0 ? now + config.retentionMs : null;

    this.dbService.db
      .prepare(
        `INSERT INTO files
           (id, original_name, mime, size, storage_name, delete_token, created_at, expires_at, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.originalName,
        input.mime,
        input.size,
        input.storageName,
        input.deleteToken,
        now,
        expiresAt,
        input.sourceUrl ?? null,
      );

    return {
      ...input,
      sourceUrl: input.sourceUrl ?? null,
      createdAt: now,
      expiresAt,
      downloads: 0,
    };
  }

  /** Returns null for unknown IDs and for rows whose expiry has passed. */
  findById(id: string): StoredFile | null {
    const row = this.dbService.db
      .prepare('SELECT * FROM files WHERE id = ?')
      .get(id) as FileRow | undefined;

    if (!row) return null;

    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      // Lazily reap rather than serving something already past its TTL.
      void this.delete(row.id);
      return null;
    }

    return toStoredFile(row);
  }

  recordDownload(id: string): void {
    this.dbService.db
      .prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?')
      .run(id);
  }

  async delete(id: string): Promise<boolean> {
    const row = this.dbService.db
      .prepare('SELECT * FROM files WHERE id = ?')
      .get(id) as FileRow | undefined;

    if (!row) return false;

    this.dbService.db.prepare('DELETE FROM files WHERE id = ?').run(id);

    try {
      await unlink(join(config.uploadDir, row.storage_name));
    } catch (error) {
      // Row is gone either way; a missing blob is not worth failing the request.
      this.logger.warn(`Could not unlink blob for ${id}: ${String(error)}`);
    }

    return true;
  }

  absolutePath(file: StoredFile): string {
    return join(config.uploadDir, file.storageName);
  }

  /** Called on a timer by CleanupService. */
  async purgeExpired(): Promise<number> {
    const rows = this.dbService.db
      .prepare('SELECT id FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(Date.now()) as Array<{ id: string }>;

    for (const row of rows) {
      await this.delete(row.id);
    }

    return rows.length;
  }
}
