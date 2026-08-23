import { config } from '../config/config';
import { decideServing } from '../common/mime';
import { StoredFile } from './file.entity';

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
}

export function buildFileResponse(file: StoredFile, via?: string): FileResponse {
  const serving = decideServing(file.mime);

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
    embeddable: serving.embeddable,
    expiresAt: file.expiresAt,
    ...(file.sourceUrl ? { sourceUrl: file.sourceUrl } : {}),
    ...(via ? { via } : {}),
  };
}
