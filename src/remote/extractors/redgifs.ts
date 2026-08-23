import { RemoteFetchError, fetchJson } from '../http';
import { hostMatches, type MediaCandidate, type SiteExtractor } from './index';

/**
 * Redgifs renders everything client-side, so there is no usable og:video on
 * the page — a niche or search URL carries the OpenGraph tags of the *listing*,
 * not of the clip you were looking at. The gif ID is in the URL though, and
 * the public API turns it into a plain MP4 on media.redgifs.com.
 *
 * Handles the shapes people actually paste:
 *   /watch/<id>            the canonical page
 *   /ifr/<id>              the embed iframe
 *   /niches/<x>?gif=<id>   a listing with a clip open on top of it
 */
const ID_FROM_PATH = /^\/(?:watch|ifr|i)\/([a-z0-9]+)/i;

interface TemporaryToken {
  token?: string;
}

interface GifResponse {
  gif?: {
    id?: string;
    urls?: Record<string, string | undefined>;
  };
}

/**
 * The temporary token is valid for a day and is bound to our IP and
 * User-Agent, so it is worth holding onto — but it is cheap to re-mint, and a
 * stale one just means one wasted request.
 */
let cached: { token: string; expiresAt: number } | null = null;

async function getToken(force: boolean): Promise<string> {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.token;

  const body = await fetchJson<TemporaryToken>('https://api.redgifs.com/v2/auth/temporary');
  if (!body.token) throw new RemoteFetchError('Redgifs would not issue a guest token');

  cached = { token: body.token, expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
  return cached.token;
}

function idFrom(url: URL): string | null {
  const fromQuery = url.searchParams.get('gif');
  if (fromQuery) return fromQuery.toLowerCase();

  const fromPath = ID_FROM_PATH.exec(url.pathname);
  // Media filenames are `AcceptableMetallicPig.mp4`; the API wants lowercase.
  return fromPath ? fromPath[1].toLowerCase() : null;
}

export const redgifs: SiteExtractor = {
  name: 'redgifs',

  supports: (url) => hostMatches(url, 'redgifs.com'),

  async resolve(url) {
    const id = idFrom(url);
    if (!id) throw new RemoteFetchError('No Redgifs clip in that link');

    const fetchGif = async (token: string): Promise<GifResponse> =>
      fetchJson<GifResponse>(`https://api.redgifs.com/v2/gifs/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${token}` },
      });

    let body: GifResponse;
    try {
      body = await fetchGif(await getToken(false));
    } catch {
      // Almost always an expired cached token. One retry with a fresh one.
      body = await fetchGif(await getToken(true));
    }

    const urls = body.gif?.urls ?? {};
    const name = body.gif?.id ?? id;

    // hd first, then the mobile encode, then the audio-stripped copy. The
    // poster image is a last resort so a video-only failure still gives you
    // something linkable.
    const candidates: MediaCandidate[] = [];
    for (const [key, label] of [
      ['hd', 'Redgifs HD'],
      ['sd', 'Redgifs SD'],
      ['silent', 'Redgifs (silent)'],
      ['poster', 'Redgifs poster'],
    ] as const) {
      const href = urls[key];
      if (!href) continue;
      candidates.push({
        url: href,
        filename: `${name}${key === 'poster' ? '.jpg' : '.mp4'}`,
        headers: { referer: 'https://www.redgifs.com/' },
        label,
      });
    }

    if (candidates.length === 0) throw new RemoteFetchError('Redgifs returned no media for that clip');
    return candidates;
  },
};
