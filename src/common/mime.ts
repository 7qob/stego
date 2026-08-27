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
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);

/**
 * Embeddable types plus things a browser can safely display but Discord will
 * not embed. Everything here is inert: a decoder bug aside, none of these can
 * execute script on our origin, which is the only property that matters.
 *
 * Still deliberately absent, and it must stay that way: `text/html`,
 * `image/svg+xml`, `application/xhtml+xml`, `text/xml`. Those are scripting
 * containers. Widening this list is the single easiest way to turn this app
 * into a stored-XSS delivery service.
 */
const INLINE_SAFE = new Set([
  ...EMBEDDABLE,
  // Images browsers render but Discord ignores.
  'image/bmp',
  'image/vnd.microsoft.icon',
  'image/x-icon',
  'image/jxl',
  'image/heic',
  'image/heif',
  // Media containers a browser may or may not decode; harmless to try.
  'video/ogg',
  'video/x-matroska',
  'audio/webm',
  'audio/aac',
  'audio/opus',
  'application/pdf',
  'text/plain',
]);

/**
 * Text-ish types that are safe as `text/plain` but must never be served with
 * their own Content-Type: a browser rendering `text/xml` or `text/csv` inline
 * is at best inconsistent and at worst, for anything XML-shaped, scriptable.
 *
 * Serving them as plain text is what lets you paste a log, a diff, a JSON blob
 * or a subtitle file and have the link just open in a browser.
 */
const AS_PLAIN_TEXT = new Set([
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/x-log',
  'text/x-diff',
  'text/x-patch',
  'text/vtt',
  'text/calendar',
  'text/x-python',
  'text/x-shellscript',
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-sh',
  'application/javascript',
  'text/javascript',
  'text/css',
]);

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

  // Note the downgrade: the *stored* type stays whatever it was, but what
  // goes on the wire is text/plain. `application/javascript` served as
  // text/plain is a file you can read; served as itself it is a script
  // another site can pull in from your origin.
  if (AS_PLAIN_TEXT.has(mime)) {
    return {
      contentType: 'text/plain; charset=utf-8',
      disposition: 'inline',
      embeddable: false,
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

/** Types the metadata scrubber knows how to walk without re-encoding. */
export function isScrubbable(mime: string): boolean {
  const m = mime.split(';')[0].trim().toLowerCase();
  return m === 'image/png' || m === 'image/jpeg' || m === 'image/webp' || m === 'image/gif';
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

/**
 * Extension to append when a source gives us bytes but no usable filename —
 * a remote URL ending in `/watch` or a bare content-addressed path. Cosmetic
 * only: nothing about serving depends on it, and unknown types stay bare.
 */
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/jxl': '.jxl',
  'image/tiff': '.tiff',
  'image/vnd.microsoft.icon': '.ico',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/opus': '.opus',
  'audio/webm': '.weba',
  'video/ogg': '.ogv',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-7z-compressed': '.7z',
  'application/x-rar-compressed': '.rar',
  'application/x-xz': '.xz',
  'application/zstd': '.zst',
  'application/json': '.json',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/plain': '.txt',
};

export function extensionForMime(mime: string): string {
  return EXTENSIONS[mime.split(';')[0].trim().toLowerCase()] ?? '';
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
