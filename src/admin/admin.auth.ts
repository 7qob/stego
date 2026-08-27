import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { constantTimeEquals, generateSecret, hashPassword, verifyPassword } from '../common/ids';
import { config } from '../config/config';
import { deriveKey } from '../config/secret';
import { readCookie } from '../files/unlock.service';

/**
 * Admin authentication.
 *
 * Three decisions worth stating, because each of them is the reason a
 * different attack does not work:
 *
 *  1. With no password configured, `isEnabled()` is false and every admin
 *     route answers 404. Not 401, not "admin disabled" — the same 404 as a
 *     path that was never routed. An instance without an admin panel does not
 *     admit that the software has one.
 *
 *  2. A session is a signed statement plus a nonce held in memory. The
 *     signature makes it unforgeable; the nonce makes it revocable, which a
 *     pure JWT-style token is not. Logging out and restarting both invalidate
 *     every session immediately.
 *
 *  3. Failed logins lock out the hashed client tag, and the password check
 *     runs even when the tag is already locked out. Skipping the scrypt call
 *     on a locked-out attempt would make "locked out" measurably faster than
 *     "wrong password", which is a free oracle.
 */

const COOKIE = 'stego_admin';

interface Attempts {
  count: number;
  lockedUntil: number;
}

@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger('Admin');

  /** Live session nonces. In memory only — a restart logs everyone out. */
  private readonly sessions = new Map<string, number>();

  private readonly attempts = new Map<string, Attempts>();

  private passwordHash = '';

  onModuleInit(): void {
    if (config.admin.passwordHash) {
      this.passwordHash = config.admin.passwordHash;
    } else if (config.admin.password) {
      // Hashing a plaintext env var at boot is not as good as being handed a
      // hash, but it does mean the scrypt parameters are ours and the
      // comparison is constant-time.
      this.passwordHash = hashPassword(config.admin.password);
      this.logger.warn(
        'Admin password came from STEGO_ADMIN_PASSWORD in plaintext. ' +
          'Prefer STEGO_ADMIN_PASSWORD_HASH from `npm run admin:hash`.',
      );
    }

    if (this.isEnabled()) {
      this.logger.log(`Admin panel enabled at ${config.admin.path}`);
    }
  }

  isEnabled(): boolean {
    return this.passwordHash.length > 0;
  }

  /**
   * Verifies a password and mints a session. Returns null on failure, which
   * the caller renders identically whether the cause was a bad password or a
   * lockout.
   */
  login(password: string, client: string, res: Response): string | null {
    const lock = this.attempts.get(client);
    const lockedOut = lock !== undefined && lock.lockedUntil > Date.now();

    // Runs regardless, so a locked-out attempt costs the same time as a real
    // one. See the note at the top of the file.
    const correct = this.passwordHash !== '' && verifyPassword(password, this.passwordHash);

    if (lockedOut || !correct) {
      this.recordFailure(client);
      return null;
    }

    this.attempts.delete(client);

    const nonce = generateSecret(24);
    const expiresAt = Date.now() + config.admin.sessionTtlMs;
    this.sessions.set(nonce, expiresAt);
    this.prune();

    const token = `${nonce}.${expiresAt}.${this.sign(nonce, expiresAt)}`;

    res.cookie(COOKIE, token, {
      httpOnly: true,
      // Strict, not Lax: nothing should ever navigate into the admin panel
      // from another site, and this is what stops a cross-site request from
      // carrying the session with it.
      sameSite: 'strict',
      secure: config.baseUrl.startsWith('https://'),
      maxAge: config.admin.sessionTtlMs,
      path: '/',
    });

    return token;
  }

  isAuthenticated(req: Request): boolean {
    if (!this.isEnabled()) return false;

    const raw = readCookie(req, COOKIE);
    if (!raw) return false;

    const [nonce, expiresText, signature] = raw.split('.');
    if (!nonce || !expiresText || !signature) return false;

    const expiresAt = Number(expiresText);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

    if (!constantTimeEquals(signature, this.sign(nonce, expiresAt))) return false;

    // The signature proves we minted it. The nonce proves we have not since
    // thrown it away.
    const known = this.sessions.get(nonce);
    return known !== undefined && known > Date.now();
  }

  logout(req: Request, res: Response): void {
    const raw = readCookie(req, COOKIE);
    if (raw) this.sessions.delete(raw.split('.')[0]);

    res.clearCookie(COOKIE, { path: '/' });
  }

  /** Ends every session on the instance, not just this one. */
  logoutEverywhere(res: Response): void {
    this.sessions.clear();
    res.clearCookie(COOKIE, { path: '/' });
  }

  sessionCount(): number {
    this.prune();
    return this.sessions.size;
  }

  /**
   * A token tied to the session, echoed back in a header on every mutating
   * request. SameSite=Strict already covers this in every browser that
   * honours it; this is the belt to that pair of braces.
   */
  csrfToken(req: Request): string {
    const raw = readCookie(req, COOKIE) ?? '';
    return createHmac('sha256', deriveKey(config.dataDir, 'admin-csrf'))
      .update(raw.split('.')[0] ?? '')
      .digest('base64url')
      .slice(0, 32);
  }

  csrfValid(req: Request): boolean {
    const supplied = req.headers['x-stego-csrf'];
    const value = Array.isArray(supplied) ? supplied[0] : supplied;
    if (!value) return false;
    return constantTimeEquals(value, this.csrfToken(req));
  }

  private recordFailure(client: string): void {
    const existing = this.attempts.get(client) ?? { count: 0, lockedUntil: 0 };
    existing.count += 1;

    if (existing.count >= config.admin.maxAttempts) {
      existing.lockedUntil = Date.now() + config.admin.lockoutMs;
      existing.count = 0;
      this.logger.warn('Admin login locked out after repeated failures');
    }

    this.attempts.set(client, existing);
  }

  private sign(nonce: string, expiresAt: number): string {
    return createHmac('sha256', deriveKey(config.dataDir, 'admin-session'))
      .update(`${nonce}|${expiresAt}`)
      .digest('base64url');
  }

  private prune(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(nonce);
    }
    for (const [client, attempt] of this.attempts) {
      if (attempt.lockedUntil !== 0 && attempt.lockedUntil <= now && attempt.count === 0) {
        this.attempts.delete(client);
      }
    }
  }
}
