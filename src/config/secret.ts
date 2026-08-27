import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one secret everything else hangs off.
 *
 * At-rest encryption keys, the admin session signature, the delete-token
 * pepper and the rate limiter's IP hashing salt are all HKDF-style
 * derivations of this value, so there is exactly one thing to back up and
 * exactly one thing to rotate.
 *
 * Source order matters:
 *
 *  1. `STEGO_SECRET` from the environment. Preferred, because it lives
 *     somewhere other than the data volume — an SSD that walks off without it
 *     is a pile of AES-CTR ciphertext.
 *  2. `<dataDir>/secret.key`, generated on first boot at mode 0600. Keeps a
 *     stock `docker compose up` working with no setup, at the cost of the
 *     key sitting next to the data it protects. `at-rest encryption is
 *     bootstrap-only` in that case, and we say so at startup.
 *
 * Losing the secret means losing every encrypted blob. It is not recoverable
 * and that is the point.
 */

function loadOrCreate(dataDir: string): { secret: Buffer; external: boolean } {
  const fromEnv = process.env.STEGO_SECRET?.trim();
  if (fromEnv) {
    // Any length in, 32 bytes out: a short passphrase is stretched rather
    // than rejected, so nobody is tempted to skip setting one.
    return { secret: createHash('sha256').update(fromEnv, 'utf8').digest(), external: true };
  }

  const path = join(dataDir, 'secret.key');

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw.length >= 32) {
      return { secret: Buffer.from(raw, 'base64url'), external: false };
    }
  }

  mkdirSync(dataDir, { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(path, generated.toString('base64url'), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some bind-mounted filesystems refuse chmod. The file is still written.
  }

  return { secret: generated, external: false };
}

let cached: { secret: Buffer; external: boolean } | null = null;

function root(dataDir: string): { secret: Buffer; external: boolean } {
  cached ??= loadOrCreate(dataDir);
  return cached;
}

/**
 * Domain-separated subkey. Two different purposes must never share key
 * material, or a value signed for one is replayable at the other.
 */
export function deriveKey(dataDir: string, purpose: string, salt?: Buffer): Buffer {
  const base = root(dataDir).secret;
  const hmac = createHmac('sha256', base).update(`stego/v1/${purpose}`);
  if (salt) hmac.update(salt);
  return hmac.digest();
}

/** True when the secret came from the environment rather than the data volume. */
export function secretIsExternal(dataDir: string): boolean {
  return root(dataDir).external;
}
