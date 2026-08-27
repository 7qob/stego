import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { constantTimeEquals } from '../common/ids';
import { config } from '../config/config';
import { deriveKey } from '../config/secret';
import { fileScopeTag } from '../privacy/client-id';

/**
 * Proof that this browser answered a link's passphrase, carried in a cookie so
 * the unlock survives the redirect and the subsequent range requests a video
 * player makes.
 *
 * The cookie is a signed statement, not a lookup key: nothing about it is
 * stored server-side, so there is no session table recording who unlocked
 * what and when. That is the privacy-relevant property. It also means the
 * grant cannot be revoked before it expires — acceptable for a link whose
 * whole security model is "knows the passphrase", and the expiry is an hour.
 *
 * Scoped per file via `fileScopeTag`, so unlocking one file does not hand you
 * every other locked file on the instance.
 */

const COOKIE_PREFIX = 'stego_unlock_';

@Injectable()
export class UnlockService {
  private sign(fileId: string, expiresAt: number): string {
    return createHmac('sha256', deriveKey(config.dataDir, 'unlock'))
      .update(`${fileScopeTag(fileId)}|${expiresAt}`)
      .digest('base64url');
  }

  grant(res: Response, fileId: string): void {
    const expiresAt = Date.now() + config.links.unlockTtlMs;
    const value = `${expiresAt}.${this.sign(fileId, expiresAt)}`;

    // Path-scoped as tightly as the routes allow, SameSite=Lax so following a
    // shared link from a chat client still carries it, HttpOnly because no
    // script has any reason to read it.
    res.cookie(`${COOKIE_PREFIX}${fileScopeTag(fileId)}`, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      maxAge: config.links.unlockTtlMs,
      path: '/',
    });
  }

  isUnlocked(req: Request, fileId: string): boolean {
    const raw = readCookie(req, `${COOKIE_PREFIX}${fileScopeTag(fileId)}`);
    if (!raw) return false;

    const separator = raw.indexOf('.');
    if (separator < 0) return false;

    const expiresAt = Number(raw.slice(0, separator));
    const signature = raw.slice(separator + 1);

    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

    return constantTimeEquals(signature, this.sign(fileId, expiresAt));
  }
}

/**
 * Reads one cookie without pulling in cookie-parser. The app has no other use
 * for it, and a dependency that touches every request is a dependency worth
 * not having.
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }

  return null;
}
