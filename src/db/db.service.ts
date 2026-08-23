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
  }
}
