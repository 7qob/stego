/**
 * Metadata scrubbing that never re-encodes.
 *
 * The obvious way to strip EXIF is to hand the image to sharp and write it
 * back out. That works, and it also destroys an LSB steganography payload for
 * anything lossy and can silently change bit depth or palette for anything
 * else. Since hiding data in the low bits is half of what this app is for,
 * the scrubber instead walks the container format and drops the chunks that
 * carry metadata, leaving every pixel byte exactly where it was.
 *
 * What comes out is byte-identical image data with the GPS coordinates, the
 * camera serial number, the editing history and the original filename gone.
 *
 * Every parser here is defensive in the same way: the moment the bytes stop
 * looking like the format we think we are reading, we return the input
 * untouched. A file that keeps its EXIF is a privacy miss; a file we
 * corrupted is data loss, and those are not the same size of mistake.
 */

/** PNG ancillary chunks that carry text, timestamps or an embedded EXIF blob. */
const PNG_STRIP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'dSIG', 'sPLT']);

/**
 * JPEG APP segments to drop. APP0 is JFIF (density, needed for correct
 * display) and APP2 is usually an ICC colour profile, without which wide-gamut
 * photos render wrong — both stay. Everything else in the APP range is EXIF
 * (APP1), Photoshop/IPTC (APP13), or a vendor's private annotation.
 */
function isStrippableJpegMarker(marker: number): boolean {
  if (marker === 0xfe) return true; // COM, a free-text comment
  if (marker < 0xe0 || marker > 0xef) return false; // not an APP segment
  return marker !== 0xe0 && marker !== 0xe2; // keep JFIF and ICC
}

export interface ScrubResult {
  data: Buffer;
  /** Bytes of metadata removed. 0 means the file had none, or we left it alone. */
  removed: number;
}

export function scrubMetadata(input: Buffer, mime: string): ScrubResult {
  const type = mime.split(';')[0].trim().toLowerCase();

  try {
    const data =
      type === 'image/png'
        ? scrubPng(input)
        : type === 'image/jpeg'
          ? scrubJpeg(input)
          : type === 'image/webp'
            ? scrubWebp(input)
            : type === 'image/gif'
              ? scrubGif(input)
              : null;

    if (!data) return { data: input, removed: 0 };
    return { data, removed: Math.max(0, input.length - data.length) };
  } catch {
    // Malformed input, or a variant of the format this parser does not know.
    // Serving the original is the safe failure.
    return { data: input, removed: 0 };
  }
}

/* PNG ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function scrubPng(input: Buffer): Buffer | null {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  const kept: Buffer[] = [input.subarray(0, 8)];
  let offset = 8;
  let sawEnd = false;

  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length; // length + type + data + crc

    if (length > input.length || end > input.length) return null;

    if (!PNG_STRIP.has(type)) kept.push(input.subarray(offset, end));

    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }

  // A PNG with trailing bytes after IEND is either damaged or carrying a
  // payload appended by something else. Either way it is not ours to rewrite.
  if (!sawEnd || offset !== input.length) return null;

  return Buffer.concat(kept);
}

/* JPEG ----------------------------------------------------------------- */

function scrubJpeg(input: Buffer): Buffer | null {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null;

  const kept: Buffer[] = [input.subarray(0, 2)]; // SOI
  let offset = 2;

  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) return null;

    const marker = input[offset + 1];

    // Standalone markers carry no payload length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      kept.push(input.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    const length = input.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > input.length) return null;

    const end = offset + 2 + length;

    if (!isStrippableJpegMarker(marker)) kept.push(input.subarray(offset, end));

    offset = end;

    // Start of scan: everything after this is entropy-coded image data plus
    // the EOI marker. Copy it verbatim — there is nothing to strip in there
    // and nothing that can be parsed as segments.
    if (marker === 0xda) {
      kept.push(input.subarray(offset));
      return Buffer.concat(kept);
    }
  }

  return null; // ran out of bytes without ever reaching a scan
}

/* WebP ----------------------------------------------------------------- */

function scrubWebp(input: Buffer): Buffer | null {
  if (input.length < 12) return null;
  if (input.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (input.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunks: Buffer[] = [];
  let offset = 12;
  let strippedAny = false;

  while (offset + 8 <= input.length) {
    const fourcc = input.toString('ascii', offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    // RIFF chunks are padded to an even length; the pad byte is not counted.
    const padded = size + (size % 2);
    const end = offset + 8 + padded;

    if (end > input.length) return null;

    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      strippedAny = true;
    } else if (fourcc === 'VP8X') {
      // The extended-format header advertises which optional chunks follow.
      // Leaving the EXIF/XMP bits set after removing the chunks makes strict
      // decoders reject the file, so clear them.
      const chunk = Buffer.from(input.subarray(offset, end));
      chunk[8] &= ~0b0000_1100; // bit 2 = XMP, bit 3 = EXIF
      chunks.push(chunk);
    } else {
      chunks.push(input.subarray(offset, end));
    }

    offset = end;
  }

  if (offset !== input.length) return null;
  if (!strippedAny) return input;

  const body = Buffer.concat(chunks);
  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(body.length + 4, 4); // size counts the "WEBP" fourcc
  out.write('WEBP', 8, 'ascii');
  body.copy(out, 12);

  return out;
}

/* GIF ------------------------------------------------------------------ */

function scrubGif(input: Buffer): Buffer | null {
  const header = input.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  if (input.length < 13) return null;

  const kept: Buffer[] = [];
  let offset = 0;

  // Header + logical screen descriptor, then the global colour table if the
  // packed field says there is one.
  const packed = input[10];
  const globalTable = (packed & 0x80) !== 0 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  offset = 13 + globalTable;
  if (offset > input.length) return null;
  kept.push(input.subarray(0, offset));

  while (offset < input.length) {
    const block = input[offset];

    if (block === 0x3b) {
      // Trailer.
      kept.push(input.subarray(offset, offset + 1));
      offset += 1;
      break;
    }

    if (block === 0x21) {
      const label = input[offset + 1];
      const start = offset;
      let cursor = offset + 2;

      // Application extensions carry an 11-byte identifier before their data
      // sub-blocks; the others go straight into sub-blocks.
      if (label === 0xff) cursor += 1 + input[cursor];

      cursor = skipSubBlocks(input, cursor);
      if (cursor < 0) return null;

      const identifier = label === 0xff ? input.toString('ascii', start + 3, start + 14) : '';

      // Drop comments and XMP. Keep NETSCAPE2.0 — that is the loop count, and
      // without it an animation plays exactly once.
      const strip = label === 0xfe || (label === 0xff && identifier.startsWith('XMP'));
      if (!strip) kept.push(input.subarray(start, cursor));

      offset = cursor;
      continue;
    }

    if (block === 0x2c) {
      // Image descriptor: 10 bytes, optional local colour table, LZW min code
      // size, then sub-blocks of pixel data. Copied through untouched.
      const start = offset;
      const local = input[offset + 9];
      let cursor = offset + 10 + ((local & 0x80) !== 0 ? 3 * (1 << ((local & 0x07) + 1)) : 0);
      cursor += 1; // LZW minimum code size
      cursor = skipSubBlocks(input, cursor);
      if (cursor < 0) return null;

      kept.push(input.subarray(start, cursor));
      offset = cursor;
      continue;
    }

    return null; // unknown block type; stop rather than guess
  }

  return Buffer.concat(kept);
}

/** Walks a chain of length-prefixed sub-blocks. Returns -1 if it runs off the end. */
function skipSubBlocks(input: Buffer, start: number): number {
  let cursor = start;
  while (cursor < input.length) {
    const size = input[cursor];
    cursor += 1;
    if (size === 0) return cursor;
    cursor += size;
  }
  return -1;
}
