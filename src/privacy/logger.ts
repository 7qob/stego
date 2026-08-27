import { ConsoleLogger, LogLevel } from '@nestjs/common';

/**
 * Nest's default logger is chatty in exactly the wrong way for this app: an
 * unhandled error prints a stack trace containing the request URL, and a
 * request URL contains a file ID. Anyone with read access to the journal then
 * has a list of every link handed out.
 *
 * This logger redacts on the way out rather than asking every call site to
 * remember. The patterns cover the things that identify a person or a file:
 * share IDs, delete tokens, unlock and admin cookies, IP addresses, and the
 * URLs of imports.
 */

const REDACTIONS: Array<[RegExp, string]> = [
  // Share paths of every flavour, including the ones added for private links.
  [/\/(f|v|r|d|s|u)\/[A-Za-z0-9_-]{6,}/g, '/$1/<id>'],
  // Anything that looks like a token in a query string or JSON body.
  [/((?:token|key|password|secret|pass)["'=:\s]{1,4})[A-Za-z0-9_\-+/=.]{8,}/gi, '$1<redacted>'],
  // Cookie values.
  [/(stego_(?:admin|unlock)[^=]*=)[^;\s]+/g, '$1<redacted>'],
  // IPv4 and the common IPv6 forms.
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>'],
  [/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi, '<ip>'],
  // Imported URLs name a third party and often a specific piece of content.
  [/\bhttps?:\/\/[^\s"'<>)]+/gi, '<url>'],
];

function redact(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export class ScrubbingLogger extends ConsoleLogger {
  /**
   * `log`, `warn`, `error`, `debug` and `verbose` all funnel through
   * printMessages in ConsoleLogger, but overriding each entry point is the
   * documented seam and survives a Nest minor bump better than patching the
   * private one.
   */
  log(message: unknown, ...rest: unknown[]): void {
    super.log(redact(message), ...rest.map(redact));
  }

  warn(message: unknown, ...rest: unknown[]): void {
    super.warn(redact(message), ...rest.map(redact));
  }

  error(message: unknown, ...rest: unknown[]): void {
    super.error(redact(message), ...rest.map(redact));
  }

  debug(message: unknown, ...rest: unknown[]): void {
    super.debug(redact(message), ...rest.map(redact));
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(redact(message), ...rest.map(redact));
  }
}

/**
 * Startup noise lists every route, which is a map of the app including the
 * admin path. Quiet by default; `STEGO_LOG_LEVEL=debug` brings it back.
 */
export function logLevels(): LogLevel[] {
  const configured = process.env.STEGO_LOG_LEVEL?.toLowerCase();

  if (configured === 'debug') return ['error', 'warn', 'log', 'debug', 'verbose'];
  if (configured === 'silent') return [];
  if (configured === 'error') return ['error'];
  return ['error', 'warn', 'log'];
}
