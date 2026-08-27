import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { config } from '../config/config';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private database!: Database.Database;

  get db(): Database.Database {
    return this.database;
  }

  onModuleInit(): void {
    mkdirSync(config.uploadDir, { recursive: true });

    this.database = new Database(config.dbPath);

    // WAL lets readers proceed during a write. SQLite still has a single
    // writer, which is a non-issue here: one INSERT per upload.
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = NORMAL');
    this.database.pragma('foreign_keys = ON');

    this.migrate();
  }

  onModuleDestroy(): void {
    this.database?.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id            TEXT    PRIMARY KEY,
        original_name TEXT    NOT NULL,
        mime          TEXT    NOT NULL,
        size          INTEGER NOT NULL,
        storage_name  TEXT    NOT NULL,
        delete_token  TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER,
        downloads     INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
      CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
    `);

    // Added with URL import. Databases created before that need the column
    // bolted on; ALTER TABLE ADD COLUMN has no IF NOT EXISTS, so check first.
    this.addColumnIfMissing('files', 'source_url', 'TEXT');

    // Privacy and private-link columns. All nullable or defaulted, so an
    // existing database keeps working with every new feature switched off for
    // rows that predate it — an old row simply has no password, no burn
    // count, no encryption and is not in the library.
    this.addColumnIfMissing('files', 'key_material', 'TEXT');
    this.addColumnIfMissing('files', 'digest', 'TEXT');
    this.addColumnIfMissing('files', 'max_downloads', 'INTEGER');
    this.addColumnIfMissing('files', 'password_hash', 'TEXT');
    this.addColumnIfMissing('files', 'e2e', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('files', 'in_library', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('files', 'label', 'TEXT');
    this.addColumnIfMissing('files', 'tags', 'TEXT');
    this.addColumnIfMissing('files', 'note', 'TEXT');
    this.addColumnIfMissing('files', 'last_seen_at', 'INTEGER');

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_library ON files(in_library);
      CREATE INDEX IF NOT EXISTS idx_files_digest  ON files(digest);
    `);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
