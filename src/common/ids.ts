import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config/config';

// Unambiguous alphabet — no 0/O or 1/l/I, so IDs survive being read aloud
// or retyped from a screenshot.
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';

/**
 * `randomInt` rather than `randomBytes[i] % 32` — the alphabet is 32 symbols
 * and 256 is a clean multiple of it, so the modulo happens to be unbiased
 * here, but that is a property of this particular alphabet length and it
 * breaks silently the moment someone edits the string above.
 */
function randomString(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * Public file identifier. Five bits per character, so the default length of
 * 16 is ~80 bits — enough that enumerating the ID space is not a strategy
 * even for someone pointing a scanner at the origin for a year. The rate
 * limiter's `miss` bucket exists to make that arithmetic worse still.
 */
export function generateFileId(): string {
  return randomString(config.idLength);
}

/** Secret handed to the uploader so they can delete their own file later. */
export function generateDeleteToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Session identifiers, unlock nonces, and anything else that must not repeat. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const SCRYPT_KEYLEN = 32;

/**
 * scrypt with a per-value salt, serialised as `scrypt$<salt>$<hash>`. Used for
 * the admin password and for per-link passphrases. scrypt rather than a plain
 * hash because these are the two places a human-chosen password is the only
 * thing in the way.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Constant-time verify. Returns false for anything it cannot parse. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  try {
    const salt = Buffer.from(parts[1], 'base64url');
    const expected = Buffer.from(parts[2], 'base64url');
    if (expected.length !== SCRYPT_KEYLEN) return false;

    return timingSafeEqual(scryptSync(password, salt, SCRYPT_KEYLEN), expected);
  } catch {
    return false;
  }
}

/** Length-safe constant-time string compare for tokens and cookies. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
