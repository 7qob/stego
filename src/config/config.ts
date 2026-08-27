import { join } from 'node:path';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Leading slash, no trailing slash, so `${path}/api/...` always composes. */
function normalisePath(value: string): string {
  const trimmed = `/${value.trim().replace(/^\/+|\/+$/g, '')}`;
  return trimmed === '/' ? '/admin' : trimmed;
}

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

  /**
   * Instance-wide ceiling. 0 disables it, in which case a file lives exactly
   * as long as the per-upload timer asks for.
   */
  retentionMs: retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : 0,

  /**
   * The one knob the UI offers: delete after N minutes. 0 minutes means "no
   * timer" and leaves the file to the retention ceiling above (forever, if
   * that is off too). retentionMs still wins whenever it is shorter.
   */
  expiry: {
    defaultMinutes: Number(process.env.STEGO_EXPIRY_DEFAULT_MINUTES ?? 60),
    maxMinutes: Number(process.env.STEGO_EXPIRY_MAX_MINUTES ?? 7 * 24 * 60),
  },

  /**
   * Public file IDs. 10 characters of a 32-symbol alphabet is ~50 bits, which
   * is fine against a casual guess and thin against someone spraying a
   * scanner at the origin. 16 is ~80 bits and costs six characters.
   */
  idLength: clamp(Number(process.env.STEGO_ID_LENGTH ?? 16), 8, 64),

  /**
   * Privacy posture. The defaults assume the answer to "should this leak?"
   * is no, and every switch here exists to turn something back on.
   */
  privacy: {
    /**
     * Strip EXIF/XMP/IPTC and every other metadata container out of uploaded
     * images. GPS coordinates in a phone photo are the single most common way
     * a "just an image" upload deanonymises whoever posted it.
     *
     * The scrubber works at the container level (drops chunks/segments) and
     * never re-encodes pixels, so an LSB-stego carrier survives it intact.
     */
    stripMetadata: process.env.STEGO_STRIP_METADATA !== '0',

    /**
     * Encrypt blobs on disk with AES-256-CTR under a key derived from the
     * server secret. Protects a stolen or backed-up data volume; it does
     * nothing against someone who already has the running process.
     */
    encryptAtRest: process.env.STEGO_ENCRYPT_AT_REST !== '0',

    /**
     * Keep the original filename out of the database, replacing it with a
     * neutral `file<ext>`. Names leak plenty on their own —
     * `Q3-payroll-final.xlsx` identifies a company and a person.
     */
    forgetFilenames: process.env.STEGO_FORGET_FILENAMES === '1',

    /**
     * `X-Robots-Tag: noindex` plus a deny-all robots.txt. A shared link that
     * turns up in a search index is no longer a shared link.
     */
    noIndex: process.env.STEGO_NOINDEX !== '0',

    /**
     * Nest logs a stack trace with a URL in it on any unhandled error, and a
     * URL contains a file ID. On by default: replace the process logger with
     * one that redacts IDs, tokens and IP addresses.
     */
    scrubLogs: process.env.STEGO_SCRUB_LOGS !== '0',

    /**
     * Round `Content-Length` up to a multiple of this many bytes by padding
     * the stored blob, so an observer who can see only transfer sizes cannot
     * fingerprint a known file by its exact length. 0 disables it.
     *
     * Costs disk and breaks nothing: the padding lives after the plaintext
     * and is never served, because we serve `size` bytes and stop.
     */
    padToBytes: Math.max(0, Number(process.env.STEGO_PAD_TO_BYTES ?? 0)),

    /**
     * Ceiling on how long anything may be cached downstream, in seconds.
     *
     * A file with a delete timer is already capped at its own remaining TTL.
     * This is the cap for files with no timer at all, and it exists because
     * `immutable` on a permanent file means a deletion never reaches
     * Cloudflare's edge or a visitor's disk cache — the origin forgets and
     * everywhere else keeps serving. A day keeps edge caching genuinely
     * useful for the Discord-embed case, where the hot window is minutes,
     * while bounding how long a deleted file can outlive its deletion.
     *
     * Raise it if you would rather have the bandwidth than the bound.
     */
    maxCacheSeconds: Math.max(0, Number(process.env.STEGO_MAX_CACHE_SECONDS ?? 86_400)),
  },

  /** Link-sharing options offered per upload. */
  links: {
    /**
     * Burn-after-reading. A file with `maxDownloads` set is deleted the
     * moment the count is reached.
     */
    burnEnabled: process.env.STEGO_BURN_ENABLED !== '0',

    /** Passphrase-locked links (server-side gate, scrypt-hashed). */
    passwordEnabled: process.env.STEGO_LINK_PASSWORD_ENABLED !== '0',

    /**
     * End-to-end encrypted links. The browser encrypts before upload and puts
     * the key in the URL fragment, which no browser ever sends to a server —
     * so this instance stores bytes it genuinely cannot read.
     */
    e2eEnabled: process.env.STEGO_E2E_ENABLED !== '0',

    /** How long an unlock cookie is honoured for a password-locked file. */
    unlockTtlMs: Number(process.env.STEGO_UNLOCK_TTL_MS ?? 60 * 60 * 1000),
  },

  /**
   * Admin panel and library. With no password set the whole surface returns
   * 404 — not 401 — so an instance without one does not advertise that an
   * admin panel is a thing this software has.
   */
  admin: {
    password: process.env.STEGO_ADMIN_PASSWORD ?? '',

    /** scrypt string from `npm run admin:hash`. Preferred over the plaintext. */
    passwordHash: process.env.STEGO_ADMIN_PASSWORD_HASH ?? '',

    sessionTtlMs: Number(process.env.STEGO_ADMIN_SESSION_TTL_MS ?? 12 * 60 * 60 * 1000),

    /** Failed logins from one client before it is locked out. */
    maxAttempts: Number(process.env.STEGO_ADMIN_MAX_ATTEMPTS ?? 5),

    lockoutMs: Number(process.env.STEGO_ADMIN_LOCKOUT_MS ?? 15 * 60 * 1000),

    /**
     * Move the panel off `/admin`. Costs nothing and takes the instance out
     * of every scanner wordlist at once.
     */
    path: normalisePath(process.env.STEGO_ADMIN_PATH ?? '/admin'),
  },

  /** Rate limits. Counted against a salted hash of the client address. */
  rateLimit: {
    enabled: process.env.STEGO_RATE_LIMIT !== '0',

    windowMs: Number(process.env.STEGO_RATE_WINDOW_MS ?? 60 * 1000),

    uploads: Number(process.env.STEGO_RATE_UPLOADS ?? 20),
    imports: Number(process.env.STEGO_RATE_IMPORTS ?? 10),
    reads: Number(process.env.STEGO_RATE_READS ?? 240),

    /** Misses are counted separately: a 404 flood is ID enumeration. */
    misses: Number(process.env.STEGO_RATE_MISSES ?? 30),

    logins: Number(process.env.STEGO_RATE_LOGINS ?? 10),
  },

  /**
   * Set only when this instance sits behind a proxy you control (Cloudflare
   * Tunnel, nginx). Off by default: with it on, an attacker can forge
   * `X-Forwarded-For` and defeat every rate limit by sending a new one each
   * request.
   */
  trustProxy: process.env.STEGO_TRUST_PROXY === '1',

  /** Comma-separated origins allowed to call the API from a browser. */
  corsOrigins: (process.env.STEGO_CORS_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),

  /** URL import (`POST /api/import`). */
  remote: {
    enabled: process.env.STEGO_IMPORT_ENABLED !== '0',

    /** Same ceiling as an upload unless overridden. */
    maxBytes: Number(process.env.STEGO_IMPORT_MAX_BYTES ?? process.env.STEGO_MAX_FILE_SIZE ?? 100 * 1024 * 1024),

    /** Per-hop socket/response timeout. */
    timeoutMs: Number(process.env.STEGO_IMPORT_TIMEOUT_MS ?? 30_000),

    maxRedirects: Number(process.env.STEGO_IMPORT_MAX_REDIRECTS ?? 5),

    /** Cap on the HTML we will read while looking for OpenGraph tags. */
    maxHtmlBytes: Number(process.env.STEGO_IMPORT_MAX_HTML_BYTES ?? 1024 * 1024),

    /**
     * Imports run server-side, so every one of them is an outbound request
     * made from inside the LAN. Two at a time keeps a burst from saturating a
     * home uplink or turning the box into someone's download farm.
     */
    maxConcurrent: Number(process.env.STEGO_IMPORT_MAX_CONCURRENT ?? 2),

    /**
     * DANGEROUS. Lifts the private-address block in remote/http.ts, which is
     * the only thing standing between this endpoint and an SSRF probe of the
     * router, the Pi itself, and every other host on the LAN. Local testing
     * against a dev server is the only good reason to set it.
     */
    allowPrivateTargets: process.env.STEGO_IMPORT_ALLOW_PRIVATE === '1',

    /**
     * YouTube and the other sites yt-dlp knows. Without it an imported
     * YouTube link still works, it just stores the thumbnail — the extractor
     * falls back to that whenever this is off or the binary is missing.
     */
    ytdlp: {
      enabled: process.env.STEGO_YTDLP_ENABLED !== '0',

      path: process.env.STEGO_YTDLP_PATH ?? 'yt-dlp',

      /** Resolving a stream URL is a couple of API calls; it should be quick. */
      timeoutMs: Number(process.env.STEGO_YTDLP_TIMEOUT_MS ?? 20_000),

      /**
       * Progressive (already-muxed) formats only. Anything else hands back a
       * video-only and an audio-only URL that would need ffmpeg to join —
       * this way the bytes we download are the file we serve. 720p is the
       * practical ceiling for muxed YouTube formats anyway.
       */
      format:
        process.env.STEGO_YTDLP_FORMAT ??
        'b[ext=mp4][vcodec!=none][acodec!=none]/b[vcodec!=none][acodec!=none]',
    },

    /** Some CDNs 403 an obviously-scripted client. */
    userAgent:
      process.env.STEGO_IMPORT_USER_AGENT ??
      'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',

    /**
     * Plenty of large sites emit OpenGraph tags only to a recognised scraper —
     * YouTube serves a browser none at all. Used as a second attempt when the
     * first scrape of a page comes back empty.
     */
    crawlerUserAgent:
      process.env.STEGO_IMPORT_CRAWLER_USER_AGENT ??
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  },
} as const;
