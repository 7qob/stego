/** Row shape as stored in SQLite (snake_case, integers for timestamps). */
export interface FileRow {
  id: string;
  original_name: string;
  mime: string;
  size: number;
  storage_name: string;
  delete_token: string;
  created_at: number;
  expires_at: number | null;
  downloads: number;
  /** Set only for files pulled in by URL import; NULL for direct uploads. */
  source_url: string | null;
}

/** Camel-cased view used everywhere above the repository layer. */
export interface StoredFile {
  id: string;
  originalName: string;
  mime: string;
  size: number;
  storageName: string;
  deleteToken: string;
  createdAt: number;
  expiresAt: number | null;
  downloads: number;
  sourceUrl: string | null;
}

export function toStoredFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    originalName: row.original_name,
    mime: row.mime,
    size: row.size,
    storageName: row.storage_name,
    deleteToken: row.delete_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    downloads: row.downloads,
    sourceUrl: row.source_url ?? null,
  };
}
