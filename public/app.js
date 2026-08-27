/**
 * The uploader.
 *
 * Extracted out of index.html so the Content-Security-Policy in main.ts can
 * be a flat `script-src 'self'` with no inline exception anywhere in the app.
 *
 * The interesting part is `encryptForUpload`: when the private-link switch is
 * on, the file never leaves this browser unencrypted. The key is generated
 * here, used here, and appended to the resulting link after a `#` — which is
 * the one part of a URL that no browser transmits.
 */
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var picker = document.getElementById('picker');
  var progressSection = document.getElementById('progressSection');
  var progress = document.getElementById('progress');
  var bar = document.getElementById('bar');
  var result = document.getElementById('result');
  var errorSection = document.getElementById('errorSection');
  var errorEl = document.getElementById('error');
  var hint = document.getElementById('hint');
  var importForm = document.getElementById('importForm');
  var importUrl = document.getElementById('importUrl');
  var importBtn = document.getElementById('importBtn');
  var minutes = document.getElementById('minutes');
  var minutesHint = document.getElementById('minutesHint');
  var expiryNote = document.getElementById('expiryNote');
  var options = document.getElementById('options');
  var burnRow = document.getElementById('burnRow');
  var burn = document.getElementById('burn');
  var lockRow = document.getElementById('lockRow');
  var lock = document.getElementById('lock');
  var privateRow = document.getElementById('privateRow');
  var privateToggle = document.getElementById('private');
  var privacyNote = document.getElementById('privacyNote');
  var deleteRow = document.getElementById('deleteRow');
  var deleteDesc = document.getElementById('deleteDesc');

  /** Copy targets live here, not in inputs — the rows show them as text. */
  var values = {};
  var limits = {};

  fetch('/api/limits')
    .then(function (r) { return r.json(); })
    .then(function (l) {
      limits = l;
      hint.textContent = 'or click to choose · up to ' + formatBytes(l.maxFileSize);
      if (l.importEnabled) importForm.hidden = false;
      minutes.value = String(l.defaultExpiryMinutes);
      minutes.max = String(l.maxExpiryMinutes);
      minutesHint.textContent = 'minutes · 0 keeps it';

      if (l.burnEnabled) burnRow.hidden = false;
      if (l.passwordEnabled) lockRow.hidden = false;
      // WebCrypto needs a secure context; on plain http there is nothing to
      // offer, so the switch stays hidden rather than failing on click.
      if (l.e2eEnabled && window.crypto && window.crypto.subtle && window.isSecureContext) {
        privateRow.hidden = false;
      }
      if (l.burnEnabled || l.passwordEnabled || l.e2eEnabled) options.hidden = false;

      var notes = [];
      if (l.encryptAtRest) notes.push('encrypted on disk');
      if (l.stripMetadata) notes.push('EXIF stripped');
      privacyNote.textContent = notes.join(' · ');
    })
    .catch(function () { /* limits are a nicety; the form still works */ });

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = n / 1024;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[i];
  }

  ['dragenter', 'dragover'].forEach(function (type) {
    stage.addEventListener(type, function (e) {
      e.preventDefault();
      stage.classList.add('active');
    });
  });

  ['dragleave', 'drop'].forEach(function (type) {
    stage.addEventListener(type, function (e) {
      e.preventDefault();
      stage.classList.remove('active');
    });
  });

  stage.addEventListener('drop', function (e) {
    var transfer = e.dataTransfer;
    if (!transfer) return;

    var file = transfer.files && transfer.files[0];
    if (file) return upload(file);

    // Dragging an image out of another tab hands us a URL, not a file.
    var dropped = transfer.getData('text/uri-list') || transfer.getData('text/plain');
    if (dropped && /^https?:\/\//i.test(dropped.trim())) grab(dropped.trim());
  });

  // Paste a screenshot straight in. Every OS screenshot tool puts the image
  // on the clipboard, and this is the shortest path from one to a link.
  document.addEventListener('paste', function (e) {
    if (!e.clipboardData) return;

    var items = e.clipboardData.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue;
      var file = items[i].getAsFile();
      if (file) { e.preventDefault(); return upload(file); }
    }

    var text = e.clipboardData.getData('text/plain');
    if (text && /^https?:\/\//i.test(text.trim()) && document.activeElement !== importUrl) {
      e.preventDefault();
      grab(text.trim());
    }
  });

  importForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = importUrl.value.trim();
    if (value) grab(value);
  });

  picker.addEventListener('change', function () {
    if (picker.files[0]) upload(picker.files[0]);
  });

  // An end-to-end file cannot be previewed by a chat client, and a link the
  // server cannot read cannot be gated by a passphrase the server checks.
  privateToggle.addEventListener('change', function () {
    lock.disabled = privateToggle.checked;
    if (privateToggle.checked) lock.value = '';
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (row) {
    row.addEventListener('click', function () {
      copy(values[row.dataset.copy] || '', row);
    });
  });

  function copy(text, row) {
    var mark = row.querySelector('.row-mark use');

    function done() {
      if (!mark) return;
      mark.setAttribute('href', '#i-check');
      setTimeout(function () { mark.setAttribute('href', '#i-copy'); }, 1200);
    }

    // navigator.clipboard exists only in a secure context. Over plain http on
    // a LAN it is undefined, and the old execCommand path is all there is.
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

  /**
   * Encrypts a file in the browser and returns the blob to upload plus the
   * key to put in the fragment.
   *
   * Name and type go inside the ciphertext, so the server stores a file whose
   * every property it is ignorant of except its length.
   */
  function encryptForUpload(file) {
    var key;

    return crypto.subtle
      .generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      .then(function (generated) {
        key = generated;
        return file.arrayBuffer();
      })
      .then(function (buffer) {
        var header = new TextEncoder().encode(
          JSON.stringify({ name: file.name, type: file.type || 'application/octet-stream' })
        );

        var payload = new Uint8Array(4 + header.length + buffer.byteLength);
        new DataView(payload.buffer).setUint32(0, header.length, false);
        payload.set(header, 4);
        payload.set(new Uint8Array(buffer), 4 + header.length);

        var iv = crypto.getRandomValues(new Uint8Array(12));

        return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, payload).then(function (ct) {
          var out = new Uint8Array(12 + ct.byteLength);
          out.set(iv, 0);
          out.set(new Uint8Array(ct), 12);
          return { blob: new Blob([out], { type: 'application/octet-stream' }), iv: iv };
        });
      })
      .then(function (sealed) {
        return crypto.subtle.exportKey('raw', key).then(function (raw) {
          var binary = '';
          var view = new Uint8Array(raw);
          for (var i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
          var b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          return { blob: sealed.blob, key: b64 };
        });
      });
  }

  function upload(file) {
    start();

    if (privateToggle.checked && !privateToggle.disabled) {
      progress.classList.add('indeterminate');
      encryptForUpload(file)
        .then(function (sealed) {
          progress.classList.remove('indeterminate');
          send(sealed.blob, 'encrypted.bin', { e2e: '1' }, sealed.key);
        })
        .catch(function () {
          progress.classList.remove('indeterminate');
          fail('Could not encrypt that file in this browser.');
        });
      return;
    }

    send(file, file.name, {}, null);
  }

  function send(blob, name, extra, fragmentKey) {
    var body = new FormData();

    // Ahead of the file: multer only has these in req.body if they arrive
    // before the part it has to stream to disk.
    body.append('minutes', chosenMinutes());
    if (burn.value && parseInt(burn.value, 10) > 0) body.append('maxDownloads', burn.value);
    if (lock.value && !lock.disabled) body.append('password', lock.value);
    Object.keys(extra).forEach(function (key) { body.append(key, extra[key]); });
    body.append('file', blob, name);

    // XHR rather than fetch: it reports upload progress, which matters when
    // the server is a Pi on a home uplink.
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    xhr.upload.addEventListener('progress', function (e) {
      if (e.lengthComputable) bar.style.width = (e.loaded / e.total) * 100 + '%';
    });

    xhr.addEventListener('load', function () {
      progressSection.hidden = true;
      var payload;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch (err) {
        return fail('Unexpected server response');
      }
      if (xhr.status >= 400) return fail(payload.message || 'Upload failed');
      show(payload, fragmentKey);
    });

    xhr.addEventListener('error', function () {
      progressSection.hidden = true;
      fail('Network error');
    });

    xhr.send(body);
  }

  /** Pull a remote URL server-side. No upload progress exists to report. */
  function grab(url) {
    start();
    importUrl.value = url;
    importBtn.disabled = true;
    progress.classList.add('indeterminate');

    fetch('/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: url,
        minutes: Number(chosenMinutes()),
        maxDownloads: burn.value ? Number(burn.value) : undefined,
        password: lock.value && !lock.disabled ? lock.value : undefined
      })
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          if (!response.ok) throw new Error(payload.message || 'Import failed');
          show(payload, null);
          importUrl.value = '';
        });
      })
      .catch(function (e) { fail(e.message); })
      .then(function () {
        progressSection.hidden = true;
        progress.classList.remove('indeterminate');
        importBtn.disabled = false;
      });
  }

  /** Blank or negative is the same as "no timer". */
  function chosenMinutes() {
    var value = parseInt(minutes.value, 10);
    return String(isFinite(value) && value > 0 ? value : 0);
  }

  function formatExpiry(payload) {
    var parts = [];

    if (payload.expiresAt) {
      var left = Math.max(0, Math.round((payload.expiresAt - Date.now()) / 60000));
      var when = new Date(payload.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      parts.push('Deletes in ' + left + ' min · ' + when);
    } else {
      parts.push('Kept until you delete it');
    }

    if (payload.readsRemaining !== null && payload.readsRemaining !== undefined) {
      parts.push(payload.readsRemaining + ' read' + (payload.readsRemaining === 1 ? '' : 's') + ' then gone');
    }
    if (payload.locked) parts.push('passphrase required');
    if (payload.e2e) parts.push('end-to-end · the key is only in this link');

    return parts.join(' · ');
  }

  function start() {
    errorSection.hidden = true;
    result.hidden = true;
    progressSection.hidden = false;
    bar.style.width = '0%';
  }

  function show(payload, fragmentKey) {
    var link = payload.shareUrl || payload.url;
    if (fragmentKey) link += '#' + fragmentKey;

    values.url = link;
    values.del = payload.deleteUrl;

    document.getElementById('urlDesc').textContent = link;
    deleteDesc.textContent = 'Keep this — it is the only way to delete it early';
    deleteRow.hidden = false;
    expiryNote.textContent = formatExpiry(payload);
    result.hidden = false;
  }

  function fail(message) {
    errorEl.textContent = message;
    errorSection.hidden = false;
  }
})();
