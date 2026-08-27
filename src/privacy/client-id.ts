import { createHmac, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config/config';
import { deriveKey } from '../config/secret';

/**
 * Rate limiting needs to tell clients apart. Logs and databases do not need to
 * know who those clients are.
 *
 * So a caller is identified by HMAC(daily-rotating salt, address), truncated.
 * The salt is random per process and re-rolled every 24 hours, which means:
 *
 *  - the value cannot be reversed to an IP address, and cannot be compared
 *    against a rainbow table of the whole IPv4 space, because the salt is
 *    secret;
 *  - it stops being a stable identifier after a day, so even a memory dump
 *    from next week correlates nothing;
 *  - it never touches disk. Nothing in this app persists a client address.
 */

let salt = randomBytes(32);
let rolledAt = Date.now();
const ROLL_MS = 24 * 60 * 60 * 1000;

function currentSalt(): Buffer {
  if (Date.now() - rolledAt > ROLL_MS) {
    salt = randomBytes(32);
    rolledAt = Date.now();
  }
  return salt;
}

/**
 * The address to count against. `X-Forwarded-For` is honoured only when
 * `STEGO_TRUST_PROXY=1`, because on a directly-reachable origin any client can
 * send a different one on every request and walk straight through every limit.
 */
function addressOf(request: Request): string {
  if (config.trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const candidate = first?.split(',')[0]?.trim();
    if (candidate) return candidate;
  }

  return request.socket.remoteAddress ?? 'unknown';
}

/** Opaque, unlinkable, rotates daily. Safe to hold in memory, never stored. */
export function clientKey(request: Request): string {
  return createHmac('sha256', currentSalt()).update(addressOf(request)).digest('base64url').slice(0, 22);
}

/**
 * A stable-per-secret tag used only to scope an unlock cookie to a file, so a
 * cookie minted for one file cannot unlock another. Not derived from the
 * client at all — it is derived from the file.
 */
export function fileScopeTag(fileId: string): string {
  return createHmac('sha256', deriveKey(config.dataDir, 'unlock-scope'))
    .update(fileId)
    .digest('base64url')
    .slice(0, 16);
}
