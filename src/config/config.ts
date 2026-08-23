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
