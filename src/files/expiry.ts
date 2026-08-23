import { BadRequestException } from '@nestjs/common';
import { config } from '../config/config';

/**
 * The delete-after timer, which is the only option the upload form offers.
 *
 * Both `POST /api/upload` and `POST /api/import` take `minutes`. Absent means
 * the instance default; 0 means no timer at all, leaving the file to the
 * retention ceiling (or to live forever, if that is disabled).
 */
export function parseExpiryMinutes(value: unknown): number {
  if (value === undefined || value === null || value === '') return config.expiry.defaultMinutes;

  const minutes = typeof value === 'number' ? value : Number(String(value).trim());

  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new BadRequestException('"minutes" must be a whole number of minutes, or 0 to keep it');
  }

  if (minutes > config.expiry.maxMinutes) {
    throw new BadRequestException(
      `This instance keeps a file for at most ${config.expiry.maxMinutes} minutes`,
    );
  }

  return minutes;
}

/**
 * Absolute deadline for a new row. The per-upload timer and the instance
 * retention ceiling are both caps, so the shorter of the two wins; null only
 * when neither is set.
 */
export function expiryFor(minutes: number | undefined, now: number): number | null {
  const requested = minutes && minutes > 0 ? minutes * 60_000 : 0;
  const ceiling = config.retentionMs;

  const ttl = requested > 0 && ceiling > 0 ? Math.min(requested, ceiling) : requested || ceiling;

  return ttl > 0 ? now + ttl : null;
}
