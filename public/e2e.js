/**
 * The end-to-end reader.
 *
 * The decryption key is in the URL fragment. Browsers do not send the
 * fragment to the server — not in the request line, not in Referer — so the
 * instance hosting this file has never seen it and cannot produce it if
 * someone asks. What it holds is ciphertext and a length.
 *
 * Wire format produced by app.js and consumed here:
 *
 *   iv          12 bytes   AES-GCM nonce
 *   ciphertext  the rest   AES-256-GCM over (headerLength ‖ header ‖ file)
 *
 * and inside the plaintext:
 *
 *   headerLength 4 bytes   big-endian
 *   header       JSON      { "name": "…", "type": "…" }
 *   file         the rest
 *
 * The filename and the content type live inside the encrypted region on
 * purpose. "invoice-2024-mercer-clinic.pdf" identifies a person and an
 * organisation before a single byte of the document is read.
 */
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var nameEl = document.getElementById('name');
  var detailEl = document.getElementById('detail');
  var saveEl = document.getElementById('save');
  var errorSection = document.getElementById('errorSection');
  var errorEl = document.getElementById('error');

  function fail(message) {
    stage.textContent = '';
    stage.appendChild(document.createTextNode('—'));
    errorEl.textContent = message;
    errorSection.hidden = false;
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = n / 1024;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[i];
  }

  function fromBase64Url(text) {
    var padded = text.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    var binary = atob(padded);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  if (!window.crypto || !window.crypto.subtle) {
    // WebCrypto is unavailable on plain http outside localhost. That is the
    // browser refusing to do cryptography in a context where the page itself
    // could have been tampered with in transit, and it is right to.
    fail('This browser will not decrypt over an insecure connection. Use https.');
    return;
  }

  var fragment = location.hash.replace(/^#/, '');
  if (!fragment) {
    fail('This link is missing its key. The part after the # is what decrypts the file.');
    return;
  }

  var id = location.pathname.split('/').filter(Boolean).pop();
  var objectUrl = null;

  fetch('/r/' + encodeURIComponent(id), { credentials: 'same-origin' })
    .then(function (response) {
      if (!response.ok) throw new Error('This file is gone.');
      return response.arrayBuffer();
    })
    .then(function (buffer) {
      var raw = new Uint8Array(buffer);
      if (raw.length < 13) throw new Error('That is not an encrypted file.');

      var iv = raw.subarray(0, 12);
      var ciphertext = raw.subarray(12);

      return crypto.subtle
        .importKey('raw', fromBase64Url(fragment), { name: 'AES-GCM' }, false, ['decrypt'])
        .then(function (key) {
          return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ciphertext);
        });
    })
    .then(function (plaintext) {
      var view = new DataView(plaintext);
      var headerLength = view.getUint32(0, false);
      if (headerLength > plaintext.byteLength - 4) throw new Error('Corrupt header.');

      var header = JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext, 4, headerLength)));
      var body = new Uint8Array(plaintext, 4 + headerLength);

      // The decrypted type came from the uploader, so it is exactly as
      // untrusted as any other upload. Anything that could execute script
      // becomes an octet-stream, same rule as the server applies — a blob:
      // URL runs on this origin, so this check is not decorative.
      var type = String(header.type || 'application/octet-stream');
      if (/html|xml|svg|script/i.test(type)) type = 'application/octet-stream';

      var blob = new Blob([body], { type: type });
      objectUrl = URL.createObjectURL(blob);

      var name = String(header.name || 'file');
      nameEl.textContent = name;
      detailEl.textContent = bytes(body.length) + ' · ' + type + ' · decrypted in this browser';

      saveEl.href = objectUrl;
      saveEl.setAttribute('download', name);
      saveEl.hidden = false;

      render(type, objectUrl, name);
    })
    .catch(function (error) {
      // A wrong key and a tampered file are the same GCM failure, and neither
      // one should get a more specific message than this.
      var message = error && error.message ? error.message : '';
      fail(message.indexOf('gone') >= 0 || message.indexOf('Corrupt') >= 0
        ? message
        : 'Could not decrypt. The key in the link is wrong, or the file was altered.');
    });

  function render(type, url, name) {
    stage.textContent = '';
    stage.className = 'preview placeholder';

    if (type.indexOf('image/') === 0) {
      var img = document.createElement('img');
      img.className = 'preview';
      img.src = url;
      img.alt = name;
      stage.replaceWith(img);
      return;
    }

    if (type.indexOf('video/') === 0) {
      var video = document.createElement('video');
      video.className = 'preview';
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      stage.replaceWith(video);
      return;
    }

    if (type.indexOf('audio/') === 0) {
      var audio = document.createElement('audio');
      audio.className = 'preview';
      audio.src = url;
      audio.controls = true;
      stage.replaceWith(audio);
      return;
    }

    stage.appendChild(document.createTextNode(type));
  }

  window.addEventListener('pagehide', function () {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
})();
