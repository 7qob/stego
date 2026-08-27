import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config/config';
import { deriveKey, secretIsExternal } from '../config/secret';

/**
 * Every blob on disk goes through here.
 *
 * With `STEGO_ENCRYPT_AT_REST` on (the default) the bytes are stored as
 * AES-256-CTR under a key derived from the server secret and a per-file salt.
 * Two consequences worth stating plainly:
 *
 *  - An SSD that is stolen, RMA'd, or backed up to somewhere careless is a
 *    directory of random-looking files. `file(1)` cannot tell a PNG from a
 *    tax return, and neither can a forensic carve.
 *  - It does nothing against anyone who can read the running process or the
 *    secret. This is disk-at-rest protection, not protection from the
 *    operator. For that, see the end-to-end links, where the key never
 *    reaches this machine at all.
 *
 * CTR mode specifically, and not GCM, because Discord and every video player
 * send Range requests and CTR is seekable: the keystream at plaintext byte N
 * depends only on N, so a range read starts the counter at floor(N/16) and
 * discards N mod 16 bytes. GCM would force a full-file read per range, which
 * on a Pi serving a 90 MB video is the difference between working and not.
 *
 * Integrity is covered separately by a stored SHA-256 of the plaintext rather
 * than by an AEAD tag; `verify()` checks it on demand from the admin panel.
 */

const ALGORITHM = 'aes-256-ctr';
const IV_BYTES = 16;
const SALT_BYTES = 16;

export interface StoredBlob {
  storageName: string;
  /** Plaintext length. What we report and what we serve. */
  size: number;
  /** Hex SHA-256 of the plaintext, for dedupe and integrity checks. */
  digest: string;
  /** base64url salt+iv, or null when the blob is stored in the clear. */
  keyMaterial: string | null;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  onModuleInit(): void {
    if (!config.privacy.encryptAtRest) {
      this.logger.warn('At-rest encryption is OFF — blobs are readable on disk');
      return;
    }

    if (secretIsExternal(config.dataDir)) {
      this.logger.log('At-rest encryption on, secret from STEGO_SECRET');
    } else {
      this.logger.warn(
        'At-rest encryption on, but the key lives in <dataDir>/secret.key next to the ' +
          'data it protects. Set STEGO_SECRET to keep them apart.',
      );
    }
  }

  /**
   * Takes a plaintext file already on disk (multer streamed it there) and
   * replaces it with its encrypted form under the same name. Done in place
   * via a temp file so a crash mid-write cannot leave a half-encrypted blob
   * that we would later serve as garbage.
   */
  async sealInPlace(storageName: string): Promise<StoredBlob> {
    const path = join(config.uploadDir, storageName);
    const { size } = await stat(path);

    const digest = await this.digestOf(path);

    if (!config.privacy.encryptAtRest) {
      await this.padTo(path, size);
      return { storageName, size, digest, keyMaterial: null };
    }

    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = deriveKey(config.dataDir, 'blob', salt);

    const temporary = `${path}.sealing`;
    await pipeline(
      createReadStream(path),
      createCipheriv(ALGORITHM, key, iv),
      createWriteStream(temporary, { mode: 0o600 }),
    );
    await rename(temporary, path);

    await this.padTo(path, size);

    return {
      storageName,
      size,
      digest,
      keyMaterial: `${salt.toString('base64url')}.${iv.toString('base64url')}`,
    };
  }

  /** Same as sealInPlace but for bytes we already hold (imports, stego output). */
  async writeBuffer(storageName: string, data: Buffer): Promise<StoredBlob> {
    const path = join(config.uploadDir, storageName);
    const digest = createHash('sha256').update(data).digest('hex');

    if (!config.privacy.encryptAtRest) {
      await pipeline(Readable.from(data), createWriteStream(path, { mode: 0o600 }));
      await this.padTo(path, data.length);
      return { storageName, size: data.length, digest, keyMaterial: null };
    }

    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = deriveKey(config.dataDir, 'blob', salt);

    await pipeline(
      Readable.from(data),
      createCipheriv(ALGORITHM, key, iv),
      createWriteStream(path, { mode: 0o600 }),
    );
    await this.padTo(path, data.length);

    return {
      storageName,
      size: data.length,
      digest,
      keyMaterial: `${salt.toString('base64url')}.${iv.toString('base64url')}`,
    };
  }

  /**
   * A readable stream of plaintext bytes `[start, end]` inclusive, matching
   * HTTP Range semantics. `keyMaterial` null means the blob predates
   * encryption (or it is switched off) and is read straight through.
   */
  readRange(storageName: string, keyMaterial: string | null, start: number, end: number): Readable {
    const path = join(config.uploadDir, storageName);

    if (!keyMaterial) return createReadStream(path, { start, end });

    const [saltPart, ivPart] = keyMaterial.split('.');
    const salt = Buffer.from(saltPart, 'base64url');
    const iv = Buffer.from(ivPart, 'base64url');
    const key = deriveKey(config.dataDir, 'blob', salt);

    // Align the read to the AES block that contains `start`, advance the
    // counter to match, then throw away the bytes before `start`.
    const blockIndex = Math.floor(start / 16);
    let remainingSkip = start - blockIndex * 16;

    const decipher = createDecipheriv(ALGORITHM, key, addToCounter(iv, blockIndex));
    const source = createReadStream(path, { start: blockIndex * 16, end });

    const trimLeadingBlock = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (remainingSkip > 0) {
          const drop = Math.min(remainingSkip, chunk.length);
          remainingSkip -= drop;
          chunk = chunk.subarray(drop);
        }
        callback(null, chunk.length > 0 ? chunk : undefined);
      },
    });

    const out = source.pipe(decipher).pipe(trimLeadingBlock);

    // pipe() does not forward errors, and a read error on a blob that went
    // missing under us must reach the response rather than hanging it.
    source.on('error', (error) => out.destroy(error));
    decipher.on('error', (error) => out.destroy(error));

    return out;
  }

  /** Whole-file plaintext. Only for things that need the bytes in hand. */
  async readAll(storageName: string, keyMaterial: string | null, size: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.readRange(storageName, keyMaterial, 0, size - 1)) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /** Recomputes the plaintext digest. Used by the admin panel's integrity check. */
  async verify(storageName: string, keyMaterial: string | null, size: number): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of this.readRange(storageName, keyMaterial, 0, size - 1)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }

  async remove(storageName: string): Promise<void> {
    await unlink(join(config.uploadDir, storageName)).catch(() => undefined);
  }

  private async digestOf(path: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
  }

  /**
   * Grows the stored blob to the next multiple of `padToBytes` with random
   * bytes. Serving reads `size` bytes and stops, so the padding is never sent;
   * its only job is to stop `ls -l` on the data volume from identifying a
   * known file by its exact byte count.
   */
  private async padTo(path: string, plaintextSize: number): Promise<void> {
    const block = config.privacy.padToBytes;
    if (block <= 0) return;

    const target = Math.ceil(Math.max(plaintextSize, 1) / block) * block;
    const current = (await stat(path)).size;
    if (target <= current) return;

    const handle = await open(path, 'a');
    try {
      await handle.write(randomBytes(target - current));
    } finally {
      await handle.close();
    }
  }
}

/**
 * CTR counter arithmetic: treat the 16-byte IV as one big-endian integer and
 * add `blocks` to it, wrapping like the cipher does. Without this a range
 * read decrypts with the wrong keystream and returns noise.
 */
function addToCounter(iv: Buffer, blocks: number): Buffer {
  const counter = Buffer.from(iv);
  let carry = BigInt(blocks);

  for (let i = 15; i >= 0 && carry > 0n; i--) {
    const sum = BigInt(counter[i]) + (carry & 0xffn);
    counter[i] = Number(sum & 0xffn);
    carry = (carry >> 8n) + (sum >> 8n);
  }

  return counter;
}
