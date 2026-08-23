import { BadRequestException, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import sharp from 'sharp';

/**
 * LSB steganography over the R, G and B channels of an image.
 *
 * Two hard constraints shape everything here:
 *
 *  1. Output must be a lossless format. PNG is used unconditionally — a single
 *     JPEG round-trip destroys every low bit and the message with it.
 *  2. Alpha is left untouched. Rewriting the low bit of a fully opaque alpha
 *     channel is a visible tell in some viewers, and fully transparent pixels
 *     can have their RGB discarded by optimisers.
 *
 * Wire format written into the pixel data:
 *
 *   magic   4 bytes  "STG1"
 *   flags   1 byte   bit 0 = payload is encrypted
 *   length  4 bytes  big-endian payload length
 *   payload N bytes
 *
 * Encrypted payloads are AES-256-GCM: salt(16) ‖ iv(12) ‖ tag(16) ‖ ciphertext.
 */

const MAGIC = 'STG1';
const HEADER_BYTES = 9;
const FLAG_ENCRYPTED = 0x01;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncodeResult {
  image: Buffer;
  capacityBytes: number;
  usedBytes: number;
}

@Injectable()
export class StegoService {
  async encode(input: Buffer, message: string, password?: string): Promise<EncodeResult> {
    if (!message) throw new BadRequestException('Message is empty');

    const { data, info } = await sharp(input)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const payload = password
      ? this.encrypt(Buffer.from(message, 'utf8'), password)
      : Buffer.from(message, 'utf8');

    const frame = Buffer.alloc(HEADER_BYTES + payload.length);
    frame.write(MAGIC, 0, 'ascii');
    frame.writeUInt8(password ? FLAG_ENCRYPTED : 0, 4);
    frame.writeUInt32BE(payload.length, 5);
    payload.copy(frame, HEADER_BYTES);

    const capacityBytes = capacityFor(info.width, info.height);
    if (frame.length > capacityBytes) {
      throw new BadRequestException(
        `Message needs ${frame.length} bytes but this image holds ${capacityBytes}. ` +
          'Use a larger image or a shorter message.',
      );
    }

    writeBits(data, frame);

    return {
      image: await sharp(data, {
        raw: { width: info.width, height: info.height, channels: 4 },
      })
        .png({ compressionLevel: 9 })
        .toBuffer(),
      capacityBytes,
      usedBytes: frame.length,
    };
  }

  async decode(input: Buffer, password?: string): Promise<string> {
    const { data } = await sharp(input)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const header = readBits(data, 0, HEADER_BYTES);
    if (header.subarray(0, 4).toString('ascii') !== MAGIC) {
      throw new BadRequestException(
        'No hidden message found. If this image was re-encoded (Discord, ' +
          'screenshots, JPEG export) the payload is already gone.',
      );
    }

    const flags = header.readUInt8(4);
    const length = header.readUInt32BE(5);
    const encrypted = (flags & FLAG_ENCRYPTED) !== 0;

    if (length === 0 || HEADER_BYTES + length > data.length) {
      throw new BadRequestException('Hidden message is corrupt');
    }

    const payload = readBits(data, HEADER_BYTES, length);

    if (!encrypted) return payload.toString('utf8');

    if (!password) throw new BadRequestException('This message is encrypted — password required');
    return this.decrypt(payload, password).toString('utf8');
  }

  /** How many payload bytes an image of this size can carry. */
  async capacity(input: Buffer): Promise<number> {
    const meta = await sharp(input).metadata();
    if (!meta.width || !meta.height) throw new BadRequestException('Unreadable image');
    return Math.max(0, capacityFor(meta.width, meta.height) - HEADER_BYTES);
  }

  private encrypt(plaintext: Buffer, password: string): Buffer {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = scryptSync(password, salt, 32);

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(blob: Buffer, password: string): Buffer {
    if (blob.length < SALT_BYTES + IV_BYTES + TAG_BYTES) {
      throw new BadRequestException('Encrypted payload is truncated');
    }

    const salt = blob.subarray(0, SALT_BYTES);
    const iv = blob.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
    const tag = blob.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + TAG_BYTES);
    const ciphertext = blob.subarray(SALT_BYTES + IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // GCM auth failure is indistinguishable from a wrong password.
      throw new BadRequestException('Wrong password, or the image was altered');
    }
  }
}

function capacityFor(width: number, height: number): number {
  return Math.floor((width * height * 3) / 8);
}

/**
 * Maps a bit index onto the RGBA buffer, skipping the alpha byte of every
 * pixel: bit n lives in channel n%3 of pixel floor(n/3).
 */
function offsetForBit(bitIndex: number): number {
  const pixel = Math.floor(bitIndex / 3);
  const channel = bitIndex % 3;
  return pixel * 4 + channel;
}

function writeBits(raw: Buffer, frame: Buffer): void {
  const totalBits = frame.length * 8;
  for (let bit = 0; bit < totalBits; bit++) {
    const value = (frame[bit >> 3] >> (7 - (bit & 7))) & 1;
    const offset = offsetForBit(bit);
    raw[offset] = (raw[offset] & 0xfe) | value;
  }
}

function readBits(raw: Buffer, byteOffset: number, byteCount: number): Buffer {
  const out = Buffer.alloc(byteCount);
  const startBit = byteOffset * 8;

  for (let i = 0; i < byteCount * 8; i++) {
    const offset = offsetForBit(startBit + i);
    if (offset >= raw.length) break;
    const value = raw[offset] & 1;
    if (value) out[i >> 3] |= 1 << (7 - (i & 7));
  }

  return out;
}
