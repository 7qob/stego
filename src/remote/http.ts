/**
 * The security core of the import path, in the same sense that common/mime.ts
 * is the security core of the serving path.
 *
 * `POST /api/import` makes this box issue HTTP requests on a stranger's
 * behalf. Left unguarded that is a textbook SSRF pivot: the Pi sits on a home
 * LAN behind a tunnel, so `http://192.168.1.1/`, `http://127.0.0.1:3000/` and
 * cloud metadata endpoints are all reachable from here and from nowhere else.
 *
 * Two things make it safe:
 *
 *   1. An address block covering loopback, RFC1918, CGNAT, link-local and the
 *      IPv6 equivalents, applied to the *resolved* address, not the hostname.
 *   2. That check runs inside the `lookup` callback the socket itself uses, so
 *      there is no window between "we validated the IP" and "we connected to
 *      it". A name that answers with a public address on the first query and
 *      127.0.0.1 on the second cannot slip through, because there is only ever
 *      one query and the socket connects to exactly what we approved.
 *
 * Every redirect hop goes through the same path — an allowed host that 302s to
 * `http://169.254.169.254/` is stopped at the second hop.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { config } from '../config/config';

export class RemoteFetchError extends Error {}

function isBlockedV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast

  return false;
}

/** Returns the eight 16-bit groups, or null if the literal is unparseable. */
function expandV6(ip: string): number[] | null {
  let text = ip;

  // `::ffff:192.168.0.1` — fold the dotted tail into two hex groups so the
  // embedded IPv4 address gets judged by the IPv4 rules above.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const quad = dotted[1].split('.').map(Number);
    if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hex = `${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`;
    text = text.slice(0, dotted.index) + hex;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }

  const values = groups.map((g) => parseInt(g || '0', 16));
  if (values.length !== 8 || values.some((v) => !Number.isInteger(v) || v < 0 || v > 0xffff)) {
    return null;
  }
  return values;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isBlockedV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;

  if (g.every((v) => v === 0)) return true; // ::
  if (g.slice(0, 7).every((v) => v === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation

  // Tunnelling and translation formats can smuggle a private IPv4 address.
  if (g.slice(0, 5).every((v) => v === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedV4(v4FromGroups(g[6], g[7]));
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b) return isBlockedV4(v4FromGroups(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedV4(v4FromGroups(g[1], g[2])); // 6to4

  return false;
}

export function isBlockedAddress(address: string): boolean {
  const bare = address.split('%')[0].toLowerCase(); // drop any zone index
  const family = isIP(bare);
  if (family === 4) return isBlockedV4(bare);
  if (family === 6) return isBlockedV6(bare);
  return true; // not an address at all — refuse rather than guess
}

/**
 * The DNS resolver handed to the socket. Filtering here rather than in a
 * separate pre-flight lookup is what closes the DNS-rebinding window.
 */
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '');
      return;
    }

    const allowed = (addresses as LookupAddress[]).filter(
      (entry) => config.remote.allowPrivateTargets || !isBlockedAddress(entry.address),
    );

    if (allowed.length === 0) {
      const blocked = new Error(
        `refusing to connect to ${hostname}: it resolves to a private or reserved address`,
      ) as NodeJS.ErrnoException;
      blocked.code = 'EBLOCKED';
      callback(blocked, '');
      return;
    }

    if (options.all) {
      callback(null, allowed);
    } else {
      callback(null, allowed[0].address, allowed[0].family);
    }
  });
}

export interface RemoteResponse {
  /** URL after redirects — the base for resolving anything found in the body. */
  url: string;
  status: number;
  /** Lowercased, parameters stripped. Untrusted, exactly like a browser's. */
  contentType: string;
  contentLength: number | null;
  body: IncomingMessage;
}

export interface OpenOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
}

function parseTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RemoteFetchError('That does not look like a URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteFetchError(`Unsupported scheme "${url.protocol.replace(':', '')}"`);
  }

  // `guardedLookup` never runs for a literal address — net.connect skips DNS
  // entirely when the host is already an IP — so `http://127.0.0.1/` would
  // sail straight past it. Literals get checked here instead. parseTarget is
  // on the redirect path too, so this covers every hop.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && !config.remote.allowPrivateTargets && isBlockedAddress(literal)) {
    throw new RemoteFetchError(
      `refusing to connect to ${literal}: it is a private or reserved address`,
    );
  }

  return url;
}

/**
 * GETs a URL, following redirects, and hands back the still-open response.
 * The caller must consume or destroy `body`.
 */
export async function openRemote(
  rawUrl: string,
  options: OpenOptions = {},
): Promise<RemoteResponse> {
  const timeoutMs = options.timeoutMs ?? config.remote.timeoutMs;
  const maxRedirects = options.maxRedirects ?? config.remote.maxRedirects;

  let url = parseTarget(rawUrl);

  for (let hop = 0; ; hop++) {
    const response = await sendOnce(url, options.headers ?? {}, timeoutMs);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;

    if (status >= 300 && status < 400 && location) {
      response.resume();
      response.destroy();

      if (hop >= maxRedirects) throw new RemoteFetchError('Too many redirects');

      // Relative Locations are common. The next hop is validated on connect.
      url = parseTarget(new URL(location, url).toString());
      continue;
    }

    if (status < 200 || status >= 400) {
      response.destroy();
      throw new RemoteFetchError(`Source responded ${status}`);
    }

    const rawLength = Number(response.headers['content-length']);

    return {
      url: url.toString(),
      status,
      contentType: (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
      contentLength: Number.isFinite(rawLength) ? rawLength : null,
      body: response,
    };
  }
}

function sendOnce(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

    // Built field by field rather than handed the URL object: any userinfo in
    // the link is dropped instead of being forwarded as credentials.
    const request = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup: guardedLookup,
        headers: {
          'user-agent': config.remote.userAgent,
          accept: '*/*',
          'accept-encoding': 'identity', // keeps Content-Length meaningful
          ...headers,
        },
      },
      resolve,
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new RemoteFetchError('Source timed out'));
    });

    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error instanceof RemoteFetchError) {
        reject(error);
        return;
      }
      reject(
        new RemoteFetchError(
          error.code === 'EBLOCKED'
            ? error.message
            : `Could not reach the source (${error.code ?? error.message})`,
        ),
      );
    });

    request.end();
  });
}

/** Reads a capped prefix of a response as UTF-8 text, then closes it. */
export async function readText(response: RemoteResponse, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of response.body) {
    chunks.push(chunk as Buffer);
    total += (chunk as Buffer).length;
    if (total >= maxBytes) break; // a <meta> tag lives in <head>; we have it by now
  }

  response.body.destroy();
  return Buffer.concat(chunks).toString('utf8');
}

/** Convenience wrapper for the small JSON APIs the site extractors call. */
export async function fetchJson<T>(url: string, options: OpenOptions = {}): Promise<T> {
  const response = await openRemote(url, options);
  const text = await readText(response, config.remote.maxHtmlBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RemoteFetchError('Source returned a malformed API response');
  }
}
