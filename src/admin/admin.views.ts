import { Injectable } from '@nestjs/common';
import { config } from '../config/config';

/**
 * The panel, rendered server-side for the same reason the file viewer is:
 * there is no build step in this project and there is not going to be one.
 *
 * It reuses `/style.css` wholesale — the same panel, the same 1px lines, the
 * same monospace — and adds only the handful of rules a table needs, which
 * live in style.css alongside everything else rather than here.
 *
 * The script is served as a separate file rather than inlined so that the
 * Content-Security-Policy set in main.ts can stay at `script-src 'self'`
 * with no inline exception. That policy is worth more than the round trip.
 */
@Injectable()
export class AdminViewsService {
  renderLogin(failed: boolean): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta name="robots" content="noindex, nofollow">
    <title>stego</title>
    <meta name="theme-color" content="#0e0e0e">
    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <main class="panel">
      <header class="section head">
        <a class="brand" href="/">stego</a>
        <span class="handle">7qob</span>
      </header>
      <form class="section paste" method="post" action="${config.admin.path}/login">
        <input type="password" name="password" placeholder="passphrase" autocomplete="current-password" autofocus required>
        <button type="submit">Enter</button>
      </form>
      ${failed ? '<section class="section"><p class="error"><span>Not today.</span></p></section>' : ''}
    </main>
  </body>
</html>`;
  }

  renderPanel(csrf: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta name="robots" content="noindex, nofollow">
    <title>admin — stego</title>
    <meta name="theme-color" content="#0e0e0e">
    <meta name="stego-csrf" content="${csrf}">
    <meta name="stego-base" content="${config.admin.path}">
    <link rel="stylesheet" href="/style.css">
  </head>
  <body class="admin">
    <svg hidden aria-hidden="true">
      <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></symbol>
      <symbol id="i-trash" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></symbol>
      <symbol id="i-book" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></symbol>
      <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></symbol>
      <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></symbol>
      <symbol id="i-lock" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></symbol>
      <symbol id="i-fire" viewBox="0 0 24 24"><path d="M12 2s4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 1-3s-3 2-3 6a6 6 0 0 0 12 0c0-6-6-11-6-11z"/></symbol>
      <symbol id="i-out" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></symbol>
    </svg>

    <main class="panel wide">
      <header class="section head">
        <a class="brand" href="/">stego</a>
        <span class="handle">admin</span>
      </header>

      <section class="section stats" id="stats"></section>

      <section class="section tabs" id="tabs">
        <button type="button" class="tab active" data-scope="all">Everything</button>
        <button type="button" class="tab" data-scope="library">
          <svg class="icon"><use href="#i-book"/></svg>Library
        </button>
        <button type="button" class="tab" data-scope="transient">Temporary</button>
      </section>

      <section class="section filters">
        <input id="search" type="search" placeholder="search name, label, note or ID…" autocomplete="off" spellcheck="false">
        <select id="sort">
          <option value="newest">newest</option>
          <option value="oldest">oldest</option>
          <option value="largest">largest</option>
          <option value="downloads">most read</option>
        </select>
      </section>

      <section class="section tagrow" id="tagrow" hidden></section>

      <section class="section table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th>File</th>
              <th class="num">Size</th>
              <th>Flags</th>
              <th class="num">Reads</th>
              <th>Expires</th>
              <th class="num">Actions</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
        <p class="note" id="empty" hidden>Nothing here.</p>
      </section>

      <section class="section pager" id="pager" hidden>
        <button type="button" id="prev">Previous</button>
        <span class="note" id="range"></span>
        <button type="button" id="next">Next</button>
      </section>

      <section class="section" id="detail" hidden></section>

      <section class="section danger">
        <button type="button" id="purge">Purge everything not in the library</button>
        <button type="button" id="revoke">Sign out every session</button>
        <button type="button" id="logout"><svg class="icon"><use href="#i-out"/></svg>Sign out</button>
      </section>

      <section class="section" id="errorSection" hidden>
        <p class="error"><span id="error"></span></p>
      </section>
    </main>

    <script src="${config.admin.path}/panel.js"></script>
  </body>
</html>`;
  }

  /**
   * Plain ES2017-era JavaScript: no modules, no optional chaining, no
   * top-level await. The panel is the one page most likely to be opened from
   * whatever old tablet is lying next to the Pi.
   */
  panelScript(): string {
    return String.raw`(function () {
  'use strict';

  var base = document.querySelector('meta[name="stego-base"]').content;
  var csrf = document.querySelector('meta[name="stego-csrf"]').content;

  var state = { scope: 'all', search: '', tag: '', sort: 'newest', offset: 0, limit: 25 };
  var total = 0;

  var rows = document.getElementById('rows');
  var empty = document.getElementById('empty');
  var statsEl = document.getElementById('stats');
  var tagrow = document.getElementById('tagrow');
  var detail = document.getElementById('detail');
  var pager = document.getElementById('pager');
  var rangeEl = document.getElementById('range');
  var errorSection = document.getElementById('errorSection');
  var errorEl = document.getElementById('error');

  function fail(message) {
    errorEl.textContent = message;
    errorSection.hidden = false;
    setTimeout(function () { errorSection.hidden = true; }, 6000);
  }

  function api(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers['x-stego-csrf'] = csrf;
    if (options.body) options.headers['content-type'] = 'application/json';
    options.credentials = 'same-origin';

    return fetch(base + '/api' + path, options).then(function (response) {
      if (response.status === 204) return null;
      return response.json().then(function (payload) {
        if (!response.ok) throw new Error(payload.message || 'Request failed');
        return payload;
      });
    });
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = n / 1024;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[i];
  }

  function when(ts) {
    if (!ts) return '—';
    var delta = Math.round((ts - Date.now()) / 1000);
    var ahead = delta > 0;
    var s = Math.abs(delta);
    var text;
    if (s < 60) text = s + 's';
    else if (s < 3600) text = Math.round(s / 60) + 'm';
    else if (s < 86400) text = Math.round(s / 3600) + 'h';
    else text = Math.round(s / 86400) + 'd';
    return ahead ? 'in ' + text : text + ' ago';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent throughout: filenames are attacker-supplied and this panel
    // is the one place an admin looks at all of them at once.
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(id, title) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    if (title) svg.setAttribute('aria-label', title);
    return svg;
  }

  function copy(text, button) {
    function done() {
      var mark = button.querySelector('use');
      if (!mark) return;
      mark.setAttribute('href', '#i-check');
      setTimeout(function () { mark.setAttribute('href', '#i-copy'); }, 1200);
    }

    // navigator.clipboard needs a secure context. A panel reached over plain
    // http on the LAN does not have one, so fall back rather than throw.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    } else {
      legacyCopy(text);
      done();
    }
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
    document.body.removeChild(area);
  }

  /* Rendering ---------------------------------------------------------- */

  function renderStats(data) {
    statsEl.textContent = '';
    var s = data.stats;

    var items = [
      ['files', s.files],
      ['stored', bytes(s.bytes)],
      ['library', s.library + ' · ' + bytes(s.libraryBytes)],
      ['reads', s.downloads],
      ['expiring', s.expiring],
      ['encrypted', s.encrypted + '/' + s.files],
      ['end-to-end', s.e2e],
      ['burn', s.burn],
      ['locked', s.locked]
    ];

    items.forEach(function (pair) {
      var cell = el('div', 'stat');
      cell.appendChild(el('span', 'stat-value', String(pair[1])));
      cell.appendChild(el('span', 'stat-label', pair[0]));
      statsEl.appendChild(cell);
    });

    tagrow.textContent = '';
    if (data.tags.length) {
      tagrow.hidden = false;
      var all = el('button', 'chip' + (state.tag === '' ? ' active' : ''), 'all');
      all.type = 'button';
      all.addEventListener('click', function () { state.tag = ''; state.offset = 0; load(); });
      tagrow.appendChild(all);

      data.tags.forEach(function (entry) {
        var chip = el('button', 'chip' + (state.tag === entry.tag ? ' active' : ''), entry.tag + ' ' + entry.count);
        chip.type = 'button';
        chip.addEventListener('click', function () { state.tag = entry.tag; state.offset = 0; load(); });
        tagrow.appendChild(chip);
      });
    } else {
      tagrow.hidden = true;
    }
  }

  function flagsFor(file) {
    var wrap = el('span', 'flags');
    if (file.inLibrary) wrap.appendChild(icon('i-book', 'in library'));
    if (file.locked) wrap.appendChild(icon('i-lock', 'passphrase'));
    if (file.e2e) wrap.appendChild(icon('i-shield', 'end-to-end'));
    if (file.readsRemaining !== null) wrap.appendChild(icon('i-fire', 'burn after reading'));
    if (file.expiresAt) wrap.appendChild(icon('i-clock', 'expires'));
    return wrap;
  }

  function renderRows(payload) {
    total = payload.total;
    rows.textContent = '';
    empty.hidden = payload.items.length > 0;

    payload.items.forEach(function (file) {
      var tr = el('tr');

      var nameCell = el('td', 'name');
      var link = el('a', 'file-link', file.label || file.name);
      link.href = file.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      nameCell.appendChild(link);
      nameCell.appendChild(el('span', 'sub', file.id + ' · ' + file.servedAs));
      tr.appendChild(nameCell);

      var sizeCell = el('td', 'num', bytes(file.size));
      tr.appendChild(sizeCell);

      var flagCell = el('td');
      flagCell.appendChild(flagsFor(file));
      tr.appendChild(flagCell);

      var readsText = String(file.downloads);
      if (file.readsRemaining !== null) readsText += ' (' + file.readsRemaining + ' left)';
      tr.appendChild(el('td', 'num', readsText));

      tr.appendChild(el('td', '', file.expiresAt ? when(file.expiresAt) : (file.inLibrary ? 'kept' : 'never')));

      var actions = el('td', 'num actions-cell');

      var copyBtn = el('button', 'mini');
      copyBtn.type = 'button';
      copyBtn.title = 'Copy link';
      copyBtn.appendChild(icon('i-copy'));
      copyBtn.addEventListener('click', function () { copy(file.url, copyBtn); });
      actions.appendChild(copyBtn);

      var libBtn = el('button', 'mini' + (file.inLibrary ? ' on' : ''));
      libBtn.type = 'button';
      libBtn.title = file.inLibrary ? 'Remove from library' : 'Add to library (keeps it forever)';
      libBtn.appendChild(icon('i-book'));
      libBtn.addEventListener('click', function () {
        api('/files/' + encodeURIComponent(file.id) + '/library', {
          method: 'POST',
          body: JSON.stringify({ inLibrary: !file.inLibrary })
        }).then(load).catch(function (e) { fail(e.message); });
      });
      actions.appendChild(libBtn);

      var openBtn = el('button', 'mini', '···');
      openBtn.type = 'button';
      openBtn.title = 'Details';
      openBtn.addEventListener('click', function () { showDetail(file.id); });
      actions.appendChild(openBtn);

      var delBtn = el('button', 'mini danger');
      delBtn.type = 'button';
      delBtn.title = 'Delete';
      delBtn.appendChild(icon('i-trash'));
      delBtn.addEventListener('click', function () {
        if (!window.confirm('Delete ' + (file.label || file.name) + '? This cannot be undone.')) return;
        api('/files/' + encodeURIComponent(file.id), { method: 'DELETE' })
          .then(load)
          .catch(function (e) { fail(e.message); });
      });
      actions.appendChild(delBtn);

      tr.appendChild(actions);
      rows.appendChild(tr);
    });

    var end = Math.min(state.offset + state.limit, total);
    pager.hidden = total <= state.limit;
    rangeEl.textContent = total === 0 ? '' : (state.offset + 1) + '–' + end + ' of ' + total;
    document.getElementById('prev').disabled = state.offset === 0;
    document.getElementById('next').disabled = end >= total;
  }

  function showDetail(id) {
    api('/files/' + encodeURIComponent(id)).then(function (file) {
      detail.textContent = '';
      detail.hidden = false;

      detail.appendChild(el('h2', 'detail-title', file.label || file.name));

      var facts = el('div', 'facts');
      [
        ['id', file.id],
        ['stored type', file.mime],
        ['served as', file.servedAs],
        ['size', bytes(file.size)],
        ['created', when(file.createdAt)],
        ['last read', file.lastSeenAt ? when(file.lastSeenAt) : 'never'],
        ['at rest', file.encrypted ? 'encrypted' : 'plaintext'],
        ['source', file.sourceUrl || 'upload'],
        ['sha-256', file.digest ? file.digest.slice(0, 24) + '…' : 'unknown'],
        ['duplicates', file.duplicates.length ? file.duplicates.join(', ') : 'none']
      ].forEach(function (pair) {
        var row = el('div', 'fact');
        row.appendChild(el('span', 'fact-key', pair[0]));
        row.appendChild(el('span', 'fact-value', String(pair[1])));
        facts.appendChild(row);
      });
      detail.appendChild(facts);

      var form = el('div', 'detail-form');

      var label = el('input');
      label.type = 'text';
      label.placeholder = 'label';
      label.value = file.label || '';

      var tags = el('input');
      tags.type = 'text';
      tags.placeholder = 'tags, comma separated';
      tags.value = (file.tags || []).join(', ');

      var note = el('textarea');
      note.placeholder = 'note';
      note.rows = 2;
      note.value = file.note || '';

      var save = el('button', '', 'Save');
      save.type = 'button';
      save.addEventListener('click', function () {
        api('/files/' + encodeURIComponent(file.id) + '/meta', {
          method: 'POST',
          body: JSON.stringify({ label: label.value, tags: tags.value, note: note.value })
        }).then(function () { showDetail(file.id); load(); })
          .catch(function (e) { fail(e.message); });
      });

      form.appendChild(label);
      form.appendChild(tags);
      form.appendChild(note);
      detail.appendChild(form);

      var actions = el('div', 'detail-actions');

      var expiry = el('input');
      expiry.type = 'number';
      expiry.min = '0';
      expiry.placeholder = 'minutes';

      var setExpiry = el('button', '', 'Set timer');
      setExpiry.type = 'button';
      setExpiry.addEventListener('click', function () {
        var value = expiry.value === '' ? null : parseInt(expiry.value, 10);
        api('/files/' + encodeURIComponent(file.id) + '/expiry', {
          method: 'POST',
          body: JSON.stringify({ minutes: value })
        }).then(function () { showDetail(file.id); load(); })
          .catch(function (e) { fail(e.message); });
      });

      var verify = el('button', '', 'Verify bytes');
      verify.type = 'button';
      verify.addEventListener('click', function () {
        verify.disabled = true;
        verify.textContent = 'Checking…';
        api('/files/' + encodeURIComponent(file.id) + '/verify', { method: 'POST' })
          .then(function (result) {
            verify.textContent = result.status === 'ok' ? 'Intact' : 'Integrity: ' + result.status;
          })
          .catch(function (e) { fail(e.message); verify.textContent = 'Verify bytes'; })
          .then(function () { verify.disabled = false; });
      });

      var close = el('button', '', 'Close');
      close.type = 'button';
      close.addEventListener('click', function () { detail.hidden = true; });

      actions.appendChild(expiry);
      actions.appendChild(setExpiry);
      actions.appendChild(verify);
      actions.appendChild(close);
      detail.appendChild(actions);

      detail.scrollIntoView({ block: 'nearest' });
    }).catch(function (e) { fail(e.message); });
  }

  /* Wiring ------------------------------------------------------------- */

  function load() {
    var query = '?scope=' + encodeURIComponent(state.scope) +
      '&sort=' + encodeURIComponent(state.sort) +
      '&limit=' + state.limit +
      '&offset=' + state.offset;
    if (state.search) query += '&search=' + encodeURIComponent(state.search);
    if (state.tag) query += '&tag=' + encodeURIComponent(state.tag);

    api('/overview').then(renderStats).catch(function (e) { fail(e.message); });
    api('/files' + query).then(renderRows).catch(function (e) { fail(e.message); });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (other) {
        other.classList.remove('active');
      });
      tab.classList.add('active');
      state.scope = tab.dataset.scope;
      state.offset = 0;
      detail.hidden = true;
      load();
    });
  });

  var searchTimer = null;
  document.getElementById('search').addEventListener('input', function (event) {
    clearTimeout(searchTimer);
    var value = event.target.value;
    searchTimer = setTimeout(function () {
      state.search = value.trim();
      state.offset = 0;
      load();
    }, 200);
  });

  document.getElementById('sort').addEventListener('change', function (event) {
    state.sort = event.target.value;
    state.offset = 0;
    load();
  });

  document.getElementById('prev').addEventListener('click', function () {
    state.offset = Math.max(0, state.offset - state.limit);
    load();
  });

  document.getElementById('next').addEventListener('click', function () {
    if (state.offset + state.limit < total) { state.offset += state.limit; load(); }
  });

  document.getElementById('purge').addEventListener('click', function () {
    var answer = window.prompt('This deletes every file not in the library. Type PURGE to confirm.');
    if (answer !== 'PURGE') return;
    api('/purge', { method: 'POST', body: JSON.stringify({ confirm: 'PURGE' }) })
      .then(function (result) { fail('Removed ' + result.removed + ' file(s)'); load(); })
      .catch(function (e) { fail(e.message); });
  });

  document.getElementById('revoke').addEventListener('click', function () {
    if (!window.confirm('Sign out every admin session, including this one?')) return;
    api('/sessions/revoke', { method: 'POST' }).then(function () { location.reload(); })
      .catch(function (e) { fail(e.message); });
  });

  document.getElementById('logout').addEventListener('click', function () {
    fetch(base + '/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-stego-csrf': csrf }
    }).then(function () { location.href = '/'; });
  });

  load();
  // Expiry countdowns go stale sitting open on a screen next to the Pi.
  setInterval(load, 30000);
})();`;
  }
}
