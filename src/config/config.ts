import { join } from 'node:path';

const dataDir = process.env.STEGO_DATA_DIR ?? join(process.cwd(), 'data');
const retentionDays = Number(process.env.STEGO_RETENTION_DAYS ?? 0);

export const config = {
  port: Number(process.env.PORT ?? 3000),

  dataDir,
  uploadDir: join(dataDir, 'uploads'),
  dbPath: join(dataDir, 'stego.db'),

  /** Trailing slash stripped so we can always concatenate `${baseUrl}/f/${id}`. */
  baseUrl: (process.env.STEGO_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),

  maxFileSize: Number(process.env.STEGO_MAX_FILE_SIZE ?? 100 * 1024 * 1024),

  /** 0 disables expiry entirely. */
  retentionMs: retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : 0,
} as const;
