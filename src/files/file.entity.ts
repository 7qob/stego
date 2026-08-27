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
  /** base64url salt.iv for the at-rest cipher. NULL means stored in the clear. */
  key_material: string | null;
  /** Hex SHA-256 of the plaintext, for dedupe and integrity checks. */
  digest: string | null;
  /** Burn-after-reading count. NULL means unlimited. */
  max_downloads: number | null;
  /** scrypt hash of the per-link passphrase. NULL means no gate. */
  password_hash: string | null;
  /** 1 when the browser encrypted this before upload and we hold only ciphertext. */
  e2e: number;
  /** 1 when an admin pinned this into the library, which also clears expiry. */
  in_library: number;
  label: string | null;
  /** Comma-separated, lowercased. Library organisation only. */
  tags: string | null;
  note: string | null;
  /** Last successful read. Lets the panel show what is actually being used. */
  last_seen_at: number | null;
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
  keyMaterial: string | null;
  digest: string | null;
  maxDownloads: number | null;
  passwordHash: string | null;
  e2e: boolean;
  inLibrary: boolean;
  label: string | null;
  tags: string[];
  note: string | null;
  lastSeenAt: number | null;
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
    keyMaterial: row.key_material ?? null,
    digest: row.digest ?? null,
    maxDownloads: row.max_downloads ?? null,
    passwordHash: row.password_hash ?? null,
    e2e: row.e2e === 1,
    inLibrary: row.in_library === 1,
    label: row.label ?? null,
    tags: parseTags(row.tags),
    note: row.note ?? null,
    lastSeenAt: row.last_seen_at ?? null,
  };
}

export function parseTags(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

export function serialiseTags(tags: string[]): string | null {
  const cleaned = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  return cleaned.length > 0 ? cleaned.join(',') : null;
}

/** True when this file is protected in a way that rules out a public cache. */
export function isPrivateLink(file: StoredFile): boolean {
  return file.maxDownloads !== null || file.passwordHash !== null || file.e2e;
}

/** Reads left before a burn-after-reading link destroys itself. */
export function readsRemaining(file: StoredFile): number | null {
  if (file.maxDownloads === null) return null;
  return Math.max(0, file.maxDownloads - file.downloads);
}
