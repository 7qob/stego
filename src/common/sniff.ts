/**
 * What the bytes actually are, as opposed to what the client said they are.
 *
 * This exists for two reasons at once, and they pull in the same direction:
 *
 *  Compatibility. curl, ShareX, most shell scripts and a fair number of
 *  mobile browsers send `application/octet-stream` for everything. Trusting
 *  that verbatim means a perfectly ordinary PNG uploaded from the terminal is
 *  stored as a binary attachment and never embeds anywhere. Sniffing the
 *  magic bytes fixes that without asking the user to do anything.
 *
 *  Security. It is strictly safer than believing the client. A sniffed type
 *  is derived from content, so it cannot be used to smuggle HTML in under an
 *  image label — and we only ever *narrow* to a type on the allowlist, never
 *  widen. A file we cannot identify stays an octet-stream attachment.
 *
 * Deliberately absent: anything that could resolve to text/html or
 * image/svg+xml. Those are scripting containers and there is no
 * content-sniffing result that should ever cause us to serve one inline.
 */

interface Signature {
  mime: string;
  /** Byte pattern; null entries are wildcards. */
  magic: Array<number | null>;
  offset?: number;
  /** Extra check for container formats where the first bytes are shared. */
  verify?: (buffer: Buffer) => boolean;
}

const SIGNATURES: Signature[] = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', magic: [0x42, 0x4d] },
  { mime: 'image/tiff', magic: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', magic: [0x4d, 0x4d, 0x00, 0x2a] },
  { mime: 'image/vnd.microsoft.icon', magic: [0x00, 0x00, 0x01, 0x00] },
  { mime: 'image/jxl', magic: [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20] },

  // RIFF containers share the first four bytes; the type is at offset 8.
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46], verify: (b) => b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'audio/wav', magic: [0x52, 0x49, 0x46, 0x46], verify: (b) => b.toString('ascii', 8, 12) === 'WAVE' },
  { mime: 'video/x-msvideo', magic: [0x52, 0x49, 0x46, 0x46], verify: (b) => b.toString('ascii', 8, 12) === 'AVI ' },

  // ISO base media: the brand at offset 8 separates MP4 from HEIC from AVIF.
  { mime: 'video/mp4', magic: [0x66, 0x74, 0x79, 0x70], offset: 4, verify: (b) => isoBrand(b, ['isom', 'iso2', 'mp41', 'mp42', 'dash', 'avc1', 'M4V ']) },
  { mime: 'audio/mp4', magic: [0x66, 0x74, 0x79, 0x70], offset: 4, verify: (b) => isoBrand(b, ['M4A ', 'M4B ']) },
  { mime: 'video/quicktime', magic: [0x66, 0x74, 0x79, 0x70], offset: 4, verify: (b) => isoBrand(b, ['qt  ']) },
  { mime: 'image/avif', magic: [0x66, 0x74, 0x79, 0x70], offset: 4, verify: (b) => isoBrand(b, ['avif', 'avis']) },
  { mime: 'image/heic', magic: [0x66, 0x74, 0x79, 0x70], offset: 4, verify: (b) => isoBrand(b, ['heic', 'heix', 'hevc', 'mif1', 'msf1']) },

  // Matroska and WebM both start with the EBML header; the DocType decides.
  { mime: 'video/webm', magic: [0x1a, 0x45, 0xdf, 0xa3], verify: (b) => b.subarray(0, 64).includes(Buffer.from('webm')) },
  { mime: 'video/x-matroska', magic: [0x1a, 0x45, 0xdf, 0xa3] },

  { mime: 'audio/flac', magic: [0x66, 0x4c, 0x61, 0x43] },
  { mime: 'audio/mpeg', magic: [0x49, 0x44, 0x33] }, // ID3-tagged MP3
  { mime: 'audio/mpeg', magic: [0xff, 0xfb] },
  { mime: 'audio/mpeg', magic: [0xff, 0xf3] },
  { mime: 'audio/mpeg', magic: [0xff, 0xf2] },

  // Ogg carries several codecs; the codec name sits just past the page header.
  { mime: 'audio/ogg', magic: [0x4f, 0x67, 0x67, 0x53], verify: (b) => !b.subarray(0, 64).includes(Buffer.from('theora')) },
  { mime: 'video/ogg', magic: [0x4f, 0x67, 0x67, 0x53] },

  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', magic: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/gzip', magic: [0x1f, 0x8b] },
  { mime: 'application/x-7z-compressed', magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { mime: 'application/x-rar-compressed', magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { mime: 'application/x-xz', magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { mime: 'application/zstd', magic: [0x28, 0xb5, 0x2f, 0xfd] },
  { mime: 'font/woff2', magic: [0x77, 0x4f, 0x46, 0x32] },
  { mime: 'font/woff', magic: [0x77, 0x4f, 0x46, 0x46] },
];

function isoBrand(buffer: Buffer, brands: string[]): boolean {
  const brand = buffer.toString('ascii', 8, 12);
  return brands.includes(brand);
}

function matches(buffer: Buffer, signature: Signature): boolean {
  const offset = signature.offset ?? 0;
  if (buffer.length < offset + signature.magic.length) return false;

  for (let i = 0; i < signature.magic.length; i++) {
    const expected = signature.magic[i];
    if (expected !== null && buffer[offset + i] !== expected) return false;
  }

  return signature.verify ? signature.verify(buffer) : true;
}

/**
 * Does this look like plain text?
 *
 * Only ever consulted when no magic number matched and the client told us
 * nothing useful, which is the common case for a log, a config file or a
 * `.txt` uploaded by anything that is not a browser file picker. Getting a
 * readable link out of those instead of an opaque download is most of what
 * "more compatible" means in practice.
 *
 * The markup check is not about rendering. Text/plain is safe to serve inline
 * — `nosniff` guarantees the browser will not re-parse it as HTML — but the
 * documented rule of this app is that HTML and SVG become octet-stream
 * attachments, and a sniffer that quietly promoted them to an inline type
 * would be the kind of change nobody notices until it matters.
 */
function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;

  for (const byte of head) {
    // NUL, or a control character that is not tab/LF/CR/FF. One of these in
    // the first 64 bytes means binary.
    if (byte === 0) return false;
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
    if (byte === 0x7f) return false;
  }

  const start = head.toString('utf8').trimStart().slice(0, 16).toLowerCase();
  if (start.startsWith('<') && /^<[!?a-z/]/.test(start)) return false;

  return true;
}

/** The type the first bytes say this is, or null if nothing recognises them. */
export function sniffMime(head: Buffer): string | null {
  for (const signature of SIGNATURES) {
    if (matches(head, signature)) return signature.mime;
  }
  return null;
}

/**
 * Formats that are really a zip or a gzip stream wearing a hat. Sniffing one
 * of these tells us the envelope, not the document, so a specific client
 * claim (`.docx`, `.epub`, `.apk`) is more useful than what we detected.
 */
const CONTAINER_TYPES = new Set(['application/zip', 'application/gzip']);

/**
 * Reconciles the client's claim with what the bytes say.
 *
 * The sniffed type wins whenever the two disagree about something that
 * matters, which is the conservative choice in both directions: a client
 * claiming `image/png` over a zip gets served as a zip, and a client claiming
 * `application/octet-stream` over a real PNG gets served as a PNG.
 *
 * The exception is a generic container. Sniffing a `.docx` finds a zip,
 * because a docx *is* a zip; there the client's more specific label is the
 * better answer and nothing is at risk, since neither type is served inline.
 */
export function resolveMime(claimed: string | undefined, head: Buffer): string {
  const sniffed = sniffMime(head);
  const normalised = (claimed ?? '').split(';')[0].trim().toLowerCase();

  // Never let an unverifiable claim reach a scripting container.
  const claimIsScriptable =
    normalised === 'text/html' || normalised === 'image/svg+xml' || normalised.includes('xhtml');

  if (sniffed) {
    if (CONTAINER_TYPES.has(sniffed) && normalised && !claimIsScriptable && normalised !== 'application/octet-stream') {
      return normalised;
    }
    return sniffed;
  }

  if (claimIsScriptable) return 'application/octet-stream';

  // A client that said nothing, or said "binary" over something that is
  // plainly not binary. curl without a type, a fetch() of a bare Blob, and
  // most mobile share sheets all land here.
  if (!normalised || normalised === 'application/octet-stream') {
    return looksLikeText(head) ? 'text/plain' : 'application/octet-stream';
  }

  return normalised;
}

/** How many bytes sniffing needs. Everything above is decided inside 64. */
export const SNIFF_BYTES = 64;
