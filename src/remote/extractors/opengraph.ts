import type { MediaCandidate } from './index';

/**
 * The generic fallback: if a link points at an HTML page, read the same
 * metadata Discord itself would read and import whatever it advertises.
 *
 * This is a deliberately dumb tag scrape rather than a DOM parse — the whole
 * point of the no-dependency stack is that we do not pull in an HTML parser
 * to read four <meta> tags out of a <head>.
 *
 * The candidates come back ordered, and plenty of them are lies: `og:video`
 * on a YouTube page is an *embed player page*, not a video file. The importer
 * resolves that by trying each in turn and rejecting anything that answers
 * with HTML, so a page like that quietly falls through to its og:image.
 */
const META_TAG = /<meta\b[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;

/** Ordered best-first; the first match for each key wins. */
const WANTED: Array<{ keys: string[]; label: string }> = [
  { keys: ['og:video:secure_url', 'og:video:url', 'og:video'], label: 'og:video' },
  { keys: ['twitter:player:stream'], label: 'twitter:player:stream' },
  { keys: ['og:audio:secure_url', 'og:audio:url', 'og:audio'], label: 'og:audio' },
  { keys: ['og:image:secure_url', 'og:image:url', 'og:image'], label: 'og:image' },
  { keys: ['twitter:image:src', 'twitter:image'], label: 'twitter:image' },
];

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/** Only the five predefined entities plus numerics ever show up in a URL. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(decodeEntities(href.trim()), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function candidatesFromHtml(html: string, baseUrl: string): MediaCandidate[] {
  const head = html.slice(0, 512 * 1024);

  // A page may repeat og:image; keep every value, in document order, per key.
  const found = new Map<string, string[]>();
  for (const tag of head.match(META_TAG) ?? []) {
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name'))?.toLowerCase();
    const content = attribute(tag, 'content');
    if (!key || !content) continue;
    const list = found.get(key);
    if (list) list.push(content);
    else found.set(key, [content]);
  }

  const candidates: MediaCandidate[] = [];
  const seen = new Set<string>();

  const push = (href: string | null, label: string): void => {
    if (!href) return;
    const resolved = absolute(href, baseUrl);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push({ url: resolved, label, headers: { referer: baseUrl } });
  };

  for (const { keys, label } of WANTED) {
    for (const key of keys) {
      for (const value of found.get(key) ?? []) push(value, label);
    }
  }

  // Last resort: the old-school thumbnail hint, still emitted by some galleries.
  for (const tag of head.match(LINK_TAG) ?? []) {
    if ((attribute(tag, 'rel') ?? '').toLowerCase() === 'image_src') {
      push(attribute(tag, 'href'), 'link[image_src]');
    }
  }

  return candidates;
}
