import { redgifs } from './redgifs';
import { youtube } from './youtube';

/**
 * One thing we might be able to download. Extractors return an ordered list
 * of these, best first — the importer walks it and keeps the first candidate
 * that turns out to be actual media rather than another HTML page.
 */
export interface MediaCandidate {
  url: string;
  /** Preferred name for the stored file, if the source suggests a good one. */
  filename?: string;
  /** Extra request headers this particular CDN needs (usually a Referer). */
  headers?: Record<string, string>;
  /** Short description of where this came from, for the API response. */
  label: string;
}

/**
 * A site that needs more than OpenGraph tags — usually because the page is
 * rendered client-side, so the media URL only exists in a JSON API.
 */
export interface SiteExtractor {
  name: string;
  supports(url: URL): boolean;
  resolve(url: URL): Promise<MediaCandidate[]>;
}

const extractors: SiteExtractor[] = [redgifs, youtube];

export function extractorFor(url: URL): SiteExtractor | null {
  return extractors.find((candidate) => candidate.supports(url)) ?? null;
}

/** Hostname match that also covers subdomains, without matching `evilredgifs.com`. */
export function hostMatches(url: URL, domain: string): boolean {
  const host = url.hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}
