import { Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../../config/config';
import { RemoteFetchError } from '../http';
import { hostMatches, type MediaCandidate, type SiteExtractor } from './index';

const run = promisify(execFile);
const logger = new Logger('youtube');

/**
 * YouTube never serves the media itself from the watch page: the streams are
 * signed, expire, and are usually split into separate video and audio tracks.
 * Working that out is yt-dlp's entire job, so we shell out to it for a
 * progressive (already-muxed) URL and then download that ourselves — which
 * keeps the size cap, the redirect rules and the private-address block in
 * remote/http.ts in charge of every byte that lands on disk.
 *
 * yt-dlp is optional. Without it — not installed, disabled, or it failed to
 * resolve anything — this falls through to the thumbnail, which is what the
 * generic OpenGraph path used to produce for a YouTube link.
 */

/** Video IDs are 11 characters of the URL-safe alphabet. Nothing else. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const PATH_ID = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/;

function idFrom(url: URL): string | null {
  if (hostMatches(url, 'youtu.be')) {
    const candidate = url.pathname.slice(1).split('/')[0];
    return VIDEO_ID.test(candidate) ? candidate : null;
  }

  const query = url.searchParams.get('v');
  if (query && VIDEO_ID.test(query)) return query;

  const path = PATH_ID.exec(url.pathname);
  return path ? path[1] : null;
}

/**
 * Asks yt-dlp for the stream URL of the best muxed format.
 *
 * The URL handed to yt-dlp is one we build from a validated 11-character ID,
 * never the string the user pasted, and execFile takes an argument array —
 * there is no shell in the middle of this and no way to smuggle a flag in.
 */
async function resolveStream(id: string): Promise<MediaCandidate | null> {
  const { path, timeoutMs, format } = config.remote.ytdlp;

  try {
    const { stdout } = await run(
      path,
      [
        '--no-playlist',
        '--no-warnings',
        // The container's root filesystem is read-only, so yt-dlp must not go
        // looking for somewhere to write a cache.
        '--no-cache-dir',
        '--skip-download',
        '--socket-timeout', '15',
        '-f', format,
        // One line each, in this order.
        '--print', '%(urls)s',
        '--print', '%(ext)s',
        '--print', '%(title)s',
        '--',
        `https://www.youtube.com/watch?v=${id}`,
      ],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
    );

    const [url, ext, title] = stdout.split('\n').map((line) => line.trim());
    if (!url || !/^https:\/\//i.test(url)) return null;

    const name = (title || id).slice(0, 80);

    return {
      url,
      filename: `${name}.${ext && /^[a-z0-9]{1,8}$/i.test(ext) ? ext : 'mp4'}`,
      label: 'yt-dlp',
    };
  } catch (error) {
    // ENOENT (not installed), a timeout, or yt-dlp exiting non-zero because
    // the video is private, age-gated or geo-blocked. None of those should
    // sink the import: the thumbnail is still a perfectly good file.
    logger.warn(`yt-dlp could not resolve ${id}: ${(error as Error).message.split('\n')[0]}`);
    return null;
  }
}

export const youtube: SiteExtractor = {
  name: 'youtube',

  // A YouTube host is not enough: a playlist, a channel or a search URL has
  // no video in it, and those are better served by the generic OpenGraph
  // scrape than by an extractor that can only fail.
  supports: (url) =>
    (hostMatches(url, 'youtube.com') ||
      hostMatches(url, 'youtu.be') ||
      hostMatches(url, 'youtube-nocookie.com')) &&
    idFrom(url) !== null,

  async resolve(url) {
    const id = idFrom(url);
    if (!id) throw new RemoteFetchError('No YouTube video in that link');

    const candidates: MediaCandidate[] = [];

    if (config.remote.ytdlp.enabled) {
      const stream = await resolveStream(id);
      if (stream) candidates.push(stream);
    }

    // maxres does not exist for every upload and 404s when it does not; hq
    // always does. Both are skipped automatically if the stream above worked.
    candidates.push(
      { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, filename: `${id}.jpg`, label: 'YouTube thumbnail' },
      { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, filename: `${id}.jpg`, label: 'YouTube thumbnail (hq)' },
    );

    return candidates;
  },
};
