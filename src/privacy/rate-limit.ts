import { Injectable } from '@nestjs/common';
import { config } from '../config/config';

/**
 * A fixed-window counter held in memory, keyed by the hashed client tag from
 * client-id.ts.
 *
 * In memory on purpose: persisting rate-limit state would mean writing a
 * per-client record to disk, which is exactly the log this app is trying not
 * to keep. Losing the counters on restart is a fair trade, and on a
 * single-process Pi there is nothing to share them with anyway.
 */

interface Window {
  count: number;
  resetAt: number;
}

export type Bucket = 'upload' | 'import' | 'read' | 'miss' | 'login';

const LIMITS: Record<Bucket, () => number> = {
  upload: () => config.rateLimit.uploads,
  import: () => config.rateLimit.imports,
  read: () => config.rateLimit.reads,
  miss: () => config.rateLimit.misses,
  login: () => config.rateLimit.logins,
};

@Injectable()
export class RateLimitService {
  private readonly windows = new Map<string, Window>();
  private lastSweep = Date.now();

  /** True when the request is allowed. False means over the limit. */
  take(bucket: Bucket, client: string): boolean {
    if (!config.rateLimit.enabled) return true;

    const limit = LIMITS[bucket]();
    if (limit <= 0) return true;

    this.sweep();

    const key = `${bucket}:${client}`;
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + config.rateLimit.windowMs });
      return true;
    }

    existing.count += 1;
    return existing.count <= limit;
  }

  /** Seconds until the caller's window rolls over, for a Retry-After header. */
  retryAfter(bucket: Bucket, client: string): number {
    const window = this.windows.get(`${bucket}:${client}`);
    if (!window) return 1;
    return Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
  }

  /** Drops elapsed windows so the map cannot grow without bound. */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;

    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
