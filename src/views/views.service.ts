import { Injectable } from '@nestjs/common';
import { config } from '../config/config';
import { escapeHtml } from '../common/html';
import { decideServing, formatBytes } from '../common/mime';
import { StoredFile, readsRemaining } from '../files/file.entity';

/**
 * Server-rendered pages, as template literals. There is no client-side
 * framework here on purpose — these pages must render before Discord's
 * scraper times out, and their whole job is to carry correct OpenGraph tags.
 *
 * Every page reuses `/style.css`, so the viewer, the unlock prompt, the
 * end-to-end reader and the admin panel are the same one-panel monospace
 * layout as the uploader.
 */
@Injectable()
export class ViewsService {
  renderFilePage(file: StoredFile): string {
    const serving = decideServing(file.mime);
    const name = escapeHtml(file.originalName);
    const rawUrl = `${config.baseUrl}/r/${file.id}`;
    const downloadUrl = `${config.baseUrl}/d/${file.id}`;
    const pageUrl = `${config.baseUrl}/v/${file.id}`;
    const size = formatBytes(file.size);
    const kind = escapeHtml(serving.contentType.split(';')[0]);

    const isImage = serving.contentType.startsWith('image/');
    const isVideo = serving.contentType.startsWith('video/');
    const isAudio = serving.contentType.startsWith('audio/');
    const isPdf = serving.contentType.startsWith('application/pdf');
    const isText = serving.contentType.startsWith('text/plain');

    // og:image only makes sense when the target really is an image; a bogus
    // one makes Discord render an empty box. og:audio is what makes Telegram
    // and Slack show a player rather than a bare link.
    const mediaTags = isImage
      ? `<meta property="og:image" content="${rawUrl}">
    <meta property="og:image:type" content="${kind}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="${rawUrl}">`
      : isVideo
        ? `<meta property="og:video" content="${rawUrl}">
    <meta property="og:video:secure_url" content="${rawUrl}">
    <meta property="og:video:type" content="${kind}">
    <meta name="twitter:card" content="player">
    <meta name="twitter:player:stream" content="${rawUrl}">`
        : isAudio
          ? `<meta property="og:audio" content="${rawUrl}">
    <meta property="og:audio:type" content="${kind}">
    <meta name="twitter:card" content="summary">`
          : '<meta name="twitter:card" content="summary">';

    const preview = isImage
      ? `<img class="preview" src="${rawUrl}" alt="${name}" loading="lazy" decoding="async">`
      : isVideo
        ? `<video class="preview" src="${rawUrl}" controls playsinline preload="metadata"></video>`
        : isAudio
          ? `<audio class="preview" src="${rawUrl}" controls preload="metadata"></audio>`
          : isPdf
            ? `<object class="preview" data="${rawUrl}" type="application/pdf"><div class="preview placeholder"><span>PDF · open it below</span></div></object>`
            : isText
              ? `<iframe class="preview" src="${rawUrl}" sandbox title="${name}"></iframe>`
              : `<div class="preview placeholder"><span>${kind}</span></div>`;

    const burn = readsRemaining(file);
    const notes = [
      file.expiresAt !== null ? `Deletes ${relativeTime(file.expiresAt)}` : null,
      burn !== null ? `${burn} read${burn === 1 ? '' : 's'} left, then it is gone` : null,
      file.passwordHash ? 'Passphrase protected' : null,
    ].filter(Boolean) as string[];

    return this.page({
      title: `${name} — stego`,
      head: `<meta property="og:type" content="website">
    <meta property="og:site_name" content="stego">
    <meta property="og:title" content="${name}">
    <meta property="og:description" content="${size} · ${kind}">
    <meta property="og:url" content="${pageUrl}">
    <link rel="alternate" type="application/json+oembed" href="${config.baseUrl}/api/oembed?url=${encodeURIComponent(pageUrl)}" title="${name}">
    ${mediaTags}`,
      body: `      <section class="section">${preview}</section>
      <section class="section meta">
        <h1>${name}</h1>
        <p>${size} · ${kind}</p>
        ${notes.map((note) => `<p class="warn">${escapeHtml(note)}</p>`).join('\n        ')}
      </section>
      <section class="section actions">
        <a class="button" href="${downloadUrl}">
          <svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download
        </a>
        <a class="button" href="${rawUrl}">
          <svg class="icon" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Direct link
        </a>
      </section>`,
    });
  }

  /**
   * The end-to-end reader.
   *
   * Everything this page needs to decrypt is after the `#` in the address bar,
   * and a fragment is never transmitted — not to this server, not to a proxy,
   * not into an access log. The script below fetches ciphertext, decrypts it
   * with WebCrypto, and reads the real filename and type out of the decrypted
   * header. This instance knows none of those things.
   */
  renderE2ePage(file: StoredFile): string {
    const burn = readsRemaining(file);

    return this.page({
      title: 'Encrypted — stego',
      // No OpenGraph media tags at all. There is nothing a scraper could
      // preview, and advertising the size of an encrypted blob is a small
      // leak for no benefit.
      head: `<meta name="robots" content="noindex, nofollow">
    <meta property="og:title" content="Encrypted file">
    <meta property="og:description" content="Opens only in a browser with the key from the link.">`,
      body: `      <section class="section">
        <div class="preview placeholder" id="stage"><span>Decrypting…</span></div>
      </section>
      <section class="section meta">
        <h1 id="name">Encrypted</h1>
        <p id="detail">${formatBytes(file.size)} · end-to-end</p>
        <p class="warn">The key is in the link after the # and never reached this server.</p>
        ${burn !== null ? `<p class="warn">${burn} read${burn === 1 ? '' : 's'} left, then it is gone</p>` : ''}
      </section>
      <section class="section actions">
        <a class="button" id="save" hidden download>
          <svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Save
        </a>
      </section>
      <section class="section" id="errorSection" hidden>
        <p class="error"><span id="error"></span></p>
      </section>`,
      // No inline script: the reader derives the file ID from the path and
      // the key from the fragment, which lets the CSP stay at a flat
      // `script-src 'self'` with no nonce and no inline exception anywhere.
      scriptSrc: '/e2e.js',
    });
  }

  renderUnlockPage(fileId: string, failed: boolean): string {
    return this.page({
      title: 'Locked — stego',
      head: `<meta name="robots" content="noindex, nofollow">
    <meta property="og:title" content="Protected file">
    <meta property="og:description" content="This link needs a passphrase.">`,
      body: `      <section class="section meta">
        <h1>Locked</h1>
        <p>This link is protected. Enter the passphrase to open it.</p>
      </section>
      <form class="section paste" method="post" action="/u/${escapeHtml(fileId)}">
        <input type="password" name="password" placeholder="passphrase" autocomplete="current-password" autofocus required>
        <button type="submit">Unlock</button>
      </form>
      ${failed ? '<section class="section"><p class="error"><span>Wrong passphrase.</span></p></section>' : ''}`,
    });
  }

  renderNotFound(): string {
    return this.page({
      title: 'Not found — stego',
      head: '<meta name="robots" content="noindex, nofollow">',
      body: `      <section class="section meta">
        <h1>Not found</h1>
        <p>This file does not exist, or it expired.</p>
      </section>
      <section class="section actions"><a class="button" href="/">Upload something</a></section>`,
    });
  }

  renderTooMany(): string {
    return this.page({
      title: 'Slow down — stego',
      head: '<meta name="robots" content="noindex, nofollow">',
      body: `      <section class="section meta">
        <h1>Slow down</h1>
        <p>Too many requests from here. Try again in a minute.</p>
      </section>`,
    });
  }

  /** One shell so every page is the same panel, header and stylesheet. */
  private page(parts: {
    title: string;
    head?: string;
    body: string;
    scriptSrc?: string;
  }): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>${parts.title}</title>
    <meta name="theme-color" content="#0e0e0e">
    ${parts.head ?? ''}
    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <main class="panel">
      <header class="section head">
        <a class="brand" href="/">stego</a>
        <span class="handle">7qob</span>
      </header>
${parts.body}
    </main>
${parts.scriptSrc ? `    <script src="${parts.scriptSrc}"></script>` : ''}
  </body>
</html>`;
  }
}

/** "in 42 min" / "in 2 h", for a deadline the reader cares about roughly. */
function relativeTime(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 90) return `in ${seconds} s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} h`;

  return `in ${Math.round(hours / 24)} days`;
}
