/**
 * The security core of the whole app.
 *
 * If we echo a user-supplied Content-Type back on our own origin, an uploaded
 * .html or .svg executes JavaScript as us — it can read cookies and localStorage
 * for the domain and act as any logged-in visitor. So: an explicit allowlist of
 * types we are willing to serve with their real Content-Type, and everything
 * else becomes an octet-stream attachment.
 *
 * Note the deliberate absences: image/svg+xml and text/html are NOT safe to
 * serve inline. SVG is a scripting container, not just a picture.
 */

/** Types Discord will render as a rich embed when it fetches the URL directly. */
const EMBEDDABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);

/** Embeddable types plus things a browser can safely display but Discord won't embed. */
const INLINE_SAFE = new Set([...EMBEDDABLE, 'application/pdf', 'text/plain']);

export interface ServingDecision {
  /** Content-Type we will actually send. */
  contentType: string;
  /** 'inline' or 'attachment'. */
  disposition: 'inline' | 'attachment';
  /** True if Discord will render this as a media embed. */
  embeddable: boolean;
}

export function decideServing(storedMime: string): ServingDecision {
  // Strip any parameters (`; charset=…`) and normalise before comparing.
  const mime = storedMime.split(';')[0].trim().toLowerCase();

  if (INLINE_SAFE.has(mime)) {
    return {
      // text/plain without an explicit charset is interpreted per-browser.
      contentType: mime === 'text/plain' ? 'text/plain; charset=utf-8' : mime,
      disposition: 'inline',
      embeddable: EMBEDDABLE.has(mime),
    };
  }

  return {
    contentType: 'application/octet-stream',
    disposition: 'attachment',
    embeddable: false,
  };
}

/** Types the steganography module can read and write losslessly. */
export function isStegoCarrier(mime: string): boolean {
  const m = mime.split(';')[0].trim().toLowerCase();
  return m === 'image/png' || m === 'image/bmp' || m === 'image/webp';
}

/**
 * Strips directory components and control characters from a client-supplied
 * filename. We never build a path from this — files are stored under a
 * generated ID — but it still ends up in a Content-Disposition header.
 */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/^.*[\\/]/, '');
  const cleaned = base.replace(/[\x00-\x1f\x7f"]/g, '').trim();
  return cleaned.slice(0, 255) || 'file';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
