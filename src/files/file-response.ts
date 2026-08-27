import { config } from '../config/config';
import { decideServing } from '../common/mime';
import { StoredFile, readsRemaining } from './file.entity';

/**
 * The JSON body returned by both `POST /api/upload` and `POST /api/import`.
 * Shared so the two paths can never drift — the UI treats their responses
 * interchangeably.
 */
export interface FileResponse {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
  viewUrl: string;
  rawUrl: string;
  downloadUrl: string;
  deleteToken: string;
  deleteUrl: string;
  embeddable: boolean;
  expiresAt: number | null;
  sourceUrl?: string;
  /** How an import found the bytes, e.g. "og:image". Absent for uploads. */
  via?: string;

  /**
   * The link to actually hand out. Same as `url` for an ordinary file; for an
   * end-to-end one it is the `/s/` reader, because `/f/` would hand a scraper
   * a blob of ciphertext.
   *
   * The client appends `#<key>` to this itself. The key is never in this
   * response because the server never had it.
   */
  shareUrl: string;

  /** Reads left before a burn-after-reading link destroys itself. */
  readsRemaining: number | null;
  locked: boolean;
  e2e: boolean;
}

export function buildFileResponse(file: StoredFile, via?: string): FileResponse {
  const serving = decideServing(file.mime);
  const shareUrl = file.e2e ? `${config.baseUrl}/s/${file.id}` : `${config.baseUrl}/f/${file.id}`;

  return {
    id: file.id,
    name: file.originalName,
    size: file.size,
    type: serving.contentType,
    /** Paste this into Discord. */
    url: `${config.baseUrl}/f/${file.id}`,
    viewUrl: `${config.baseUrl}/v/${file.id}`,
    rawUrl: `${config.baseUrl}/r/${file.id}`,
    downloadUrl: `${config.baseUrl}/d/${file.id}`,
    /** Shown once. Keep it to delete the file later. */
    deleteToken: file.deleteToken,
    deleteUrl: `${config.baseUrl}/api/files/${file.id}?token=${file.deleteToken}`,
    embeddable: serving.embeddable && !file.e2e,
    expiresAt: file.expiresAt,
    shareUrl,
    readsRemaining: readsRemaining(file),
    locked: file.passwordHash !== null,
    e2e: file.e2e,
    ...(file.sourceUrl ? { sourceUrl: file.sourceUrl } : {}),
    ...(via ? { via } : {}),
  };
}
