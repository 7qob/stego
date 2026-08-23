import { Injectable } from '@nestjs/common';
import { config } from '../config/config';
import { escapeHtml } from '../common/html';
import { decideServing, formatBytes } from '../common/mime';
import { StoredFile } from '../files/file.entity';

/**
 * Two pages, server-rendered as template literals. There is no client-side
 * framework here on purpose — this page must render before Discord's scraper
 * times out, and its whole job is to carry correct OpenGraph tags.
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

    // og:image only makes sense when the target really is an image; a bogus
    // one makes Discord render an empty box.
    const mediaTags = isImage
      ? `<meta property="og:image" content="${rawUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="${rawUrl}">`
      : isVideo
        ? `<meta property="og:video" content="${rawUrl}">
    <meta property="og:video:type" content="${kind}">
    <meta name="twitter:card" content="player">`
        : '<meta name="twitter:card" content="summary">';

    const preview = isImage
      ? `<img class="preview" src="${rawUrl}" alt="${name}">`
      : isVideo
        ? `<video class="preview" src="${rawUrl}" controls preload="metadata"></video>`
        : isAudio
          ? `<audio class="preview" src="${rawUrl}" controls preload="metadata"></audio>`
          : `<div class="preview placeholder"><span>${kind}</span></div>`;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${name} — stego</title>

    <meta property="og:type" content="website">
    <meta property="og:site_name" content="stego">
    <meta property="og:title" content="${name}">
    <meta property="og:description" content="${size} · ${kind}">
    <meta property="og:url" content="${pageUrl}">
    ${mediaTags}
    <meta name="theme-color" content="#0e0e0e">

    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <main class="panel">
      <header class="section head">
        <a class="brand" href="/">stego</a>
        <span class="handle">7qob</span>
      </header>
      <section class="section">${preview}</section>
      <section class="section meta">
        <h1>${name}</h1>
        <p>${size} · ${kind}</p>
      </section>
      <section class="section actions">
        <a class="button" href="${downloadUrl}">
          <svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download
        </a>
        <a class="button" href="${rawUrl}">
          <svg class="icon" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Direct link
        </a>
      </section>
    </main>
  </body>
</html>`;
  }

  renderNotFound(): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Not found — stego</title>
    <meta name="theme-color" content="#0e0e0e">
    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <main class="panel">
      <header class="section head">
        <a class="brand" href="/">stego</a>
        <span class="handle">7qob</span>
      </header>
      <section class="section meta">
        <h1>Not found</h1>
        <p>This file does not exist, or it expired.</p>
      </section>
      <section class="section actions"><a class="button" href="/">Upload something</a></section>
    </main>
  </body>
</html>`;
  }
}
