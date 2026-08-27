import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config/config';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { expiryFor } from './expiry';
import {
  FileRow,
  StoredFile,
  serialiseTags,
  toStoredFile,
} from './file.entity';

export interface CreateFileInput {
  id: string;
  originalName: string;
  mime: string;
  size: number;
  storageName: string;
  deleteToken: string;
  /** Delete-after timer in minutes. 0 (or absent) means no timer of its own. */
  expiryMinutes?: number;
  /** Where the bytes came from, when they were imported rather than uploaded. */
  sourceUrl?: string | null;
  keyMaterial?: string | null;
  digest?: string | null;
  /** Burn-after-reading: delete once this many reads have happened. */
  maxDownloads?: number | null;
  /** scrypt hash of a per-link passphrase. */
  passwordHash?: string | null;
  /** True when the client encrypted the bytes and we never see plaintext. */
  e2e?: boolean;
}

export interface ListQuery {
  search?: string;
  tag?: string;
  /** 'library' restricts to pinned items, 'transient' excludes them. */
  scope?: 'all' | 'library' | 'transient';
  limit?: number;
  offset?: number;
  sort?: 'newest' | 'oldest' | 'largest' | 'downloads';
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly storage: StorageService,
  ) {}

  create(input: CreateFileInput): StoredFile {
    const now = Date.now();
    const expiresAt = expiryFor(input.expiryMinutes, now);

    this.dbService.db
      .prepare(
        `INSERT INTO files
           (id, original_name, mime, size, storage_name, delete_token, created_at,
            expires_at, source_url, key_material, digest, max_downloads, password_hash, e2e)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.keyMaterial ?? null,
        input.digest ?? null,
        input.maxDownloads ?? null,
        input.passwordHash ?? null,
        input.e2e ? 1 : 0,
      );

    return this.requireById(input.id);
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

  private requireById(id: string): StoredFile {
    const row = this.dbService.db
      .prepare('SELECT * FROM files WHERE id = ?')
      .get(id) as FileRow;
    return toStoredFile(row);
  }

  /**
   * Counts a read and reports whether that read was the last one a
   * burn-after-reading link had.
   *
   * The increment and the check are one statement so two simultaneous
   * requests for a one-shot link cannot both see "one left" — SQLite
   * serialises writers, and `RETURNING` gives us the post-increment value
   * from inside the same write.
   */
  recordDownload(id: string): { burned: boolean } {
    const row = this.dbService.db
      .prepare(
        `UPDATE files SET downloads = downloads + 1, last_seen_at = ?
         WHERE id = ?
         RETURNING downloads, max_downloads`,
      )
      .get(Date.now(), id) as { downloads: number; max_downloads: number | null } | undefined;

    if (!row || row.max_downloads === null) return { burned: false };

    return { burned: row.downloads >= row.max_downloads };
  }

  async delete(id: string): Promise<boolean> {
    const row = this.dbService.db
      .prepare('SELECT * FROM files WHERE id = ?')
      .get(id) as FileRow | undefined;

    if (!row) return false;

    this.dbService.db.prepare('DELETE FROM files WHERE id = ?').run(id);

    try {
      await this.storage.remove(row.storage_name);
    } catch (error) {
      // Row is gone either way; a missing blob is not worth failing the request.
      this.logger.warn(`Could not unlink blob for a deleted row: ${String(error)}`);
    }

    return true;
  }

  /**
   * Called on a timer by CleanupService.
   *
   * Library items are pinned and have no expiry, so they never appear here —
   * the WHERE clause already excludes them by way of `expires_at IS NULL`.
   */
  async purgeExpired(): Promise<number> {
    const rows = this.dbService.db
      .prepare('SELECT id FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(Date.now()) as Array<{ id: string }>;

    for (const row of rows) {
      await this.delete(row.id);
    }

    return rows.length;
  }

  /**
   * Blobs on disk with no row pointing at them. A crash between the multer
   * write and the INSERT leaves one, and without a sweep they accumulate
   * silently — which for a privacy-focused host means user data outliving
   * every deletion the user asked for.
   */
  async purgeOrphans(names: string[]): Promise<number> {
    if (names.length === 0) return 0;

    const known = new Set(
      (this.dbService.db.prepare('SELECT storage_name FROM files').all() as Array<{
        storage_name: string;
      }>).map((row) => row.storage_name),
    );

    let removed = 0;
    for (const name of names) {
      if (known.has(name)) continue;
      await this.storage.remove(name);
      removed++;
    }

    return removed;
  }

  /* Admin / library ---------------------------------------------------- */

  list(query: ListQuery): { items: StoredFile[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.scope === 'library') where.push('in_library = 1');
    if (query.scope === 'transient') where.push('in_library = 0');

    if (query.search) {
      where.push('(original_name LIKE ? OR label LIKE ? OR note LIKE ? OR id = ? OR source_url LIKE ?)');
      const like = `%${query.search}%`;
      params.push(like, like, like, query.search, like);
    }

    if (query.tag) {
      // Tags are stored comma-joined; the commas on both sides make `png`
      // match `png` without also matching `png-large`.
      where.push("(',' || tags || ',') LIKE ?");
      params.push(`%,${query.tag.toLowerCase()},%`);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const order =
      query.sort === 'oldest'
        ? 'created_at ASC'
        : query.sort === 'largest'
          ? 'size DESC'
          : query.sort === 'downloads'
            ? 'downloads DESC'
            : 'created_at DESC';

    const total = (
      this.dbService.db.prepare(`SELECT COUNT(*) AS count FROM files ${clause}`).get(...params) as {
        count: number;
      }
    ).count;

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);

    const rows = this.dbService.db
      .prepare(`SELECT * FROM files ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as FileRow[];

    return { items: rows.map(toStoredFile), total };
  }

  stats(): {
    files: number;
    bytes: number;
    downloads: number;
    library: number;
    libraryBytes: number;
    expiring: number;
    encrypted: number;
    e2e: number;
    burn: number;
    locked: number;
    oldest: number | null;
  } {
    const row = this.dbService.db
      .prepare(
        `SELECT
           COUNT(*)                                          AS files,
           COALESCE(SUM(size), 0)                            AS bytes,
           COALESCE(SUM(downloads), 0)                       AS downloads,
           COALESCE(SUM(in_library), 0)                      AS library,
           COALESCE(SUM(CASE WHEN in_library = 1 THEN size ELSE 0 END), 0)   AS libraryBytes,
           COALESCE(SUM(CASE WHEN expires_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS expiring,
           COALESCE(SUM(CASE WHEN key_material IS NOT NULL THEN 1 ELSE 0 END), 0) AS encrypted,
           COALESCE(SUM(e2e), 0)                             AS e2e,
           COALESCE(SUM(CASE WHEN max_downloads IS NOT NULL THEN 1 ELSE 0 END), 0) AS burn,
           COALESCE(SUM(CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END), 0) AS locked,
           MIN(created_at)                                   AS oldest
         FROM files`,
      )
      .get() as Record<string, number | null>;

    return {
      files: Number(row.files ?? 0),
      bytes: Number(row.bytes ?? 0),
      downloads: Number(row.downloads ?? 0),
      library: Number(row.library ?? 0),
      libraryBytes: Number(row.libraryBytes ?? 0),
      expiring: Number(row.expiring ?? 0),
      encrypted: Number(row.encrypted ?? 0),
      e2e: Number(row.e2e ?? 0),
      burn: Number(row.burn ?? 0),
      locked: Number(row.locked ?? 0),
      oldest: row.oldest ?? null,
    };
  }

  /** Every tag in use, with a count, for the library's filter row. */
  tagCloud(): Array<{ tag: string; count: number }> {
    const rows = this.dbService.db
      .prepare("SELECT tags FROM files WHERE tags IS NOT NULL AND tags <> ''")
      .all() as Array<{ tags: string }>;

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags.split(',')) {
        const cleaned = tag.trim().toLowerCase();
        if (cleaned) counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /**
   * Pinning into the library clears the expiry — the whole point is that these
   * are the ones that stop being temporary. Unpinning does not restore the old
   * deadline, because it is gone; the caller sets a new one if it wants.
   */
  setLibrary(id: string, inLibrary: boolean): StoredFile | null {
    if (!this.findById(id)) return null;

    this.dbService.db
      .prepare('UPDATE files SET in_library = ?, expires_at = CASE WHEN ? = 1 THEN NULL ELSE expires_at END WHERE id = ?')
      .run(inLibrary ? 1 : 0, inLibrary ? 1 : 0, id);

    return this.requireById(id);
  }

  updateMeta(
    id: string,
    patch: { label?: string | null; tags?: string[]; note?: string | null },
  ): StoredFile | null {
    if (!this.findById(id)) return null;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.label !== undefined) {
      sets.push('label = ?');
      params.push(patch.label?.slice(0, 200) || null);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      params.push(serialiseTags(patch.tags));
    }
    if (patch.note !== undefined) {
      sets.push('note = ?');
      params.push(patch.note?.slice(0, 2000) || null);
    }

    if (sets.length > 0) {
      this.dbService.db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }

    return this.requireById(id);
  }

  /** Absolute new deadline, or null to remove the timer entirely. */
  setExpiry(id: string, minutes: number | null): StoredFile | null {
    if (!this.findById(id)) return null;

    const expiresAt = minutes === null || minutes <= 0 ? null : Date.now() + minutes * 60_000;
    this.dbService.db.prepare('UPDATE files SET expires_at = ? WHERE id = ?').run(expiresAt, id);

    return this.requireById(id);
  }

  /** Recompute the stored digest and report whether the blob still matches. */
  async verifyIntegrity(id: string): Promise<'ok' | 'mismatch' | 'unknown' | 'missing'> {
    const file = this.findById(id);
    if (!file) return 'missing';
    if (!file.digest) return 'unknown';

    try {
      const actual = await this.storage.verify(file.storageName, file.keyMaterial, file.size);
      return actual === file.digest ? 'ok' : 'mismatch';
    } catch {
      return 'missing';
    }
  }

  /** Same plaintext already here? Used by the panel to spot duplicates. */
  findByDigest(digest: string): StoredFile[] {
    const rows = this.dbService.db
      .prepare('SELECT * FROM files WHERE digest = ? ORDER BY created_at ASC')
      .all(digest) as FileRow[];
    return rows.map(toStoredFile);
  }

  /** Wipes everything that is not pinned into the library. */
  async purgeAllTransient(): Promise<number> {
    const rows = this.dbService.db
      .prepare('SELECT id FROM files WHERE in_library = 0')
      .all() as Array<{ id: string }>;

    for (const row of rows) await this.delete(row.id);
    return rows.length;
  }

  storagePath(file: StoredFile): string {
    return file.storageName;
  }

  /** Kept for callers that still want an absolute path (stego re-encode). */
  uploadDir(): string {
    return config.uploadDir;
  }
}
