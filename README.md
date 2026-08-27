# stego

Self-hosted file host. Upload anything, get a link, paste it into Discord and
it embeds like the real thing. Includes an LSB steganography encoder/decoder.

NestJS · SQLite (better-sqlite3) · plain HTML/CSS · built to run on a Raspberry Pi 5.

## Quick start

```bash
npm install
cp .env.example .env
npm run start:dev
```

Open http://localhost:3000.

## How the Discord embedding works

Discord handles links two different ways, so `stego` serves two different things:

- **Media** (png/jpeg/gif/webp/mp4/webm/mp3/…) — `/f/:id` returns the raw bytes
  with the real `Content-Type`. Discord fetches it and renders it inline.
- **Everything else** — `/f/:id` returns an HTML page carrying OpenGraph tags,
  which Discord scrapes into a link preview card.

`src/files/files.controller.ts` makes that branch; `src/common/mime.ts` decides
which types count as embeddable.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /f/:id` | Canonical share link. Raw bytes for media, OG page otherwise. |
| `GET /v/:id` | Always the HTML viewer. |
| `GET /r/:id` | Always raw bytes. Honours `Range`, `HEAD`, `If-None-Match`. |
| `GET /d/:id` | Raw bytes, forced download. |
| `GET /s/:id#key` | End-to-end reader. Decrypts in the browser. |
| `GET /u/:id` | Unlock prompt for a passphrase-protected link. |
| `POST /api/upload` | multipart, field name `file`. Returns links + delete token. |
| `POST /api/import` | `{ "url": "https://…" }`. Same response shape as upload. |
| `DELETE /api/files/:id?token=` | Delete using the token from upload. |
| `GET /api/limits` | Max size, retention policy, which link modes are on. |
| `GET /api/oembed?url=` | oEmbed, for Slack/Notion/WordPress previews. |
| `GET /api/health` | Liveness. Says nothing else, deliberately. |
| `POST /api/stego/encode` | `file` + `message` + optional `password` → PNG. |
| `POST /api/stego/decode` | `file` + optional `password` → `{ message }`. |
| `POST /api/stego/capacity` | `file` → how many bytes it can hide. |
| `GET /admin` | The panel. 404 unless an admin password is set. |

`POST /api/upload` and `POST /api/import` both take, alongside the file or
URL:

| Field | Meaning |
| --- | --- |
| `minutes` | Delete after N minutes. `0` means no timer. |
| `maxDownloads` | Burn after N reads. `0` or absent means unlimited. |
| `password` | Passphrase required before the link serves anything. |
| `e2e` | `1` if the body is already ciphertext from the browser. Upload only. |

## Security model

Two rules carry most of the weight. Both are easy to break by accident later.

**1. Never serve an uploaded file with a Content-Type you did not choose.**
`src/common/mime.ts` holds an allowlist. Anything not on it is served as
`application/octet-stream` with `Content-Disposition: attachment`. `image/svg+xml`
and `text/html` are deliberately absent — SVG is a scripting container. Without
this, an uploaded `.html` runs JavaScript on your origin.

**2. `X-Content-Type-Options: nosniff` on every response** (set in `src/main.ts`).
This is what makes it safe to accept the client's `mimetype` at face value: even
if someone uploads HTML labelled `image/png`, the browser will not re-interpret it.

Also in place: blobs stored under random extensionless names (original filename
lives only in SQLite, so no path traversal is reachable), constant-time delete
token comparison, and HTML escaping of filenames in `src/common/html.ts`.

**If this ever becomes publicly reachable**, serve user content from a separate
domain to your control panel — that turns rule 1 from load-bearing into
defence-in-depth. Rate limiting is now in the box (see below); the separate
domain is still the one thing missing.

Also in place: a `Content-Security-Policy` of `default-src 'none'` with no
inline script anywhere in the app, `Cross-Origin-Resource-Policy: same-origin`
so another site cannot hotlink files here into its own document, and rate
limits on uploads, imports, reads, logins and — separately and much more
tightly — 404s, because a flood of those is someone walking the ID space.

## Privacy

The security model above is about what an uploaded file can do to you. This is
about what a shared link says about the people using it.

**What is on by default**

| | |
| --- | --- |
| **Encrypted at rest** | Blobs are AES-256-CTR under a key derived from `STEGO_SECRET`. A stolen SSD, an RMA, or a backup that ended up somewhere careless is a directory of noise. |
| **Metadata stripped** | EXIF, XMP and IPTC are removed from PNG, JPEG, WebP and GIF on the way in — including the GPS coordinates a phone photo carries. |
| **Nothing indexed** | `X-Robots-Tag` on every response and a deny-all `robots.txt`. A shared link in a search result has stopped being a shared link. |
| **Logs scrubbed** | File IDs, delete tokens, cookies, IP addresses and imported URLs are redacted before anything reaches the journal. |
| **No client records** | Rate limits count against `HMAC(daily-rotating random salt, address)`, held in memory. Nothing in this app writes a client address to disk, ever. |
| **Long IDs** | 16 characters of a 32-symbol alphabet, ~80 bits. |

**Metadata stripping does not re-encode.** The obvious implementation hands
the image to sharp and writes it back out, which would destroy an LSB stego
payload — half of what this app is for. Instead the scrubber walks the
container and drops the chunks that carry metadata: PNG `tEXt`/`iTXt`/`eXIf`,
JPEG `APP1`/`APP13`/`COM`, RIFF `EXIF`/`XMP `, GIF comment extensions. Pixel
bytes come out identical. If the file does not parse exactly as expected it is
returned untouched — keeping the EXIF is a miss, corrupting someone's file is
not the same size of mistake.

**Three ways to share something privately**

- **Burn after reading.** `maxDownloads=1` and the file deletes itself the
  moment it has been read. Counted before the stream starts, so a client that
  disconnects halfway still spends the read.
- **Passphrase.** The link serves nothing until someone answers. A wrong
  passphrase and a nonexistent file return the same page, so the prompt is not
  an oracle for which IDs are real.
- **End-to-end.** The browser encrypts with AES-256-GCM before uploading and
  puts the key in the URL fragment. Browsers do not transmit fragments — not
  in the request line, not in `Referer` — so this instance holds ciphertext it
  cannot read. The filename and content type are inside the ciphertext too:
  the database row says `encrypted.bin`, `application/octet-stream`, and a
  length.

### What "untraceable" does and does not mean here

Worth being straight about, because the gap matters:

**This does protect against** someone who takes the disk, someone reading the
logs, a search engine finding a link, an uploaded photo's GPS tag, an exact
file size identifying a known file (`STEGO_PAD_TO_BYTES`), and — for
end-to-end links — the operator of this server, who genuinely cannot read
them.

**This does not protect against** anyone who can see the traffic. Your ISP,
Cloudflare (which terminates TLS on the tunnel and can see every byte of a
non-end-to-end file), and anyone watching the recipient's connection all know
that a transfer happened, how big it was, and when. The domain is yours; the
uplink is your home. A file shared from here is not anonymous in the sense of
"nobody can tell where it came from" — it is anonymous in the sense of "the
file itself says nothing about who made it, and the server keeps no record of
who fetched it".

If the threat model is a network observer, this is the wrong shape of tool and
no configuration of it becomes the right one.

## Admin panel and library

Set `STEGO_ADMIN_PASSWORD_HASH` (from `npm run admin:hash`) and the panel
appears at `/admin`. Without it, every admin route — including the panel
itself — answers **404, not 401**, so an instance without one does not
advertise that the software has the feature. `STEGO_ADMIN_PATH` moves it
somewhere unguessable, which is not a security control on its own but does
take the instance out of every scanner wordlist at once.

The panel shows instance stats, every file with search, sort and tag filters,
and a detail view with the stored SHA-256, duplicate detection and an
integrity check that re-reads the blob through the cipher and compares.

**The library** is the admin-only half. Pin a file and it leaves the expiry
system entirely — no timer, never swept — and gains a label, tags and a note.
It is for the things that were never meant to be temporary. `Purge everything
not in the library` does exactly that, and the library is what survives it.

Sessions are a signed cookie plus an in-memory nonce: unforgeable because of
the signature, revocable because of the nonce. Five failed logins lock out the
(hashed) client for fifteen minutes, and the password check runs even when
already locked out, so "locked" is not measurably faster than "wrong".

## Deletion, and what it actually deletes

Three things remove a file, and it takes all three to mean it:

1. **The lookup.** Anything past its deadline is reaped the moment it is
   asked for, so a request one second after expiry is a 404 and the blob is
   already gone.
2. **The sweep**, every minute, for the files nobody asks for. Worst case a
   file survives its deadline by the sweep's phase — under a minute.
3. **The cache headers.** This is the one that used to be wrong. Files were
   served `Cache-Control: max-age=31536000, immutable`, which is correct for
   content that never changes and catastrophic for content that is supposed
   to disappear: a file set to delete after five minutes stayed in the
   browser cache, and in Cloudflare's edge cache, for a year after this
   server deleted it. `max-age` is now capped at whatever is left of the TTL,
   private links are `no-store` outright, and files with no timer are bounded
   by `STEGO_MAX_CACHE_SECONDS` (a day) so a manual delete propagates.

An hourly sweep also removes blobs with no database row — a crash between the
upload landing on disk and the `INSERT` used to leave one behind forever,
which on a host like this is user data outliving the deletion it was promised.

**Discord is still a caveat.** Anything Discord proxies through
`media.discordapp.net` is copied onto their CDN, and your expiry has no
authority over their copy. If a file has to actually vanish, share it as a
burn-after-reading or end-to-end link — neither of which Discord can embed,
which is the point.

## Steganography

LSB encoding across the R/G/B channels, alpha untouched. Optional AES-256-GCM
encryption of the message (scrypt-derived key from your password).

Two things that will bite you:

- **Output is always PNG.** Any lossy re-encode destroys the payload. That is
  physics, not a bug.
- **Discord re-encodes images it proxies** through `media.discordapp.net`. A
  stego PNG posted as an embed may come out the other side stripped. Share those
  via `/d/:id` so the recipient downloads the original bytes.

```bash
curl -F file=@carrier.png -F message="hello" -F password="hunter2" \
  http://localhost:3000/api/stego/encode --output out.png

curl -F file=@out.png -F password="hunter2" \
  http://localhost:3000/api/stego/decode
```

## Running on a Raspberry Pi 5

GitHub Actions builds an arm64 image on every push and publishes it to GHCR;
the Pi pulls it and never compiles anything. **Put the data on an SSD, not the
SD card** — a file host writes constantly and will wear out SD flash.

```bash
git clone https://github.com/7qob/stego.git ~/stego && cd ~/stego
cp .env.example .env          # set STEGO_BASE_URL
docker compose pull && docker compose up -d
```

The app is published on `127.0.0.1:3000` only, so nothing can reach it until you
expose it deliberately:

```bash
./deploy/tunnel-setup.sh stego.example.com
```

That installs `cloudflared`, creates the tunnel, writes its config, creates the
DNS record and starts the service.

**[deploy/README.md](deploy/README.md) is the full runbook** — the GHCR
visibility step that trips everyone up, the Cloudflare settings that break
Discord embeds, rollback, and troubleshooting. `deploy/stego.service` is there
if you would rather build on the Pi and run under systemd without Docker.

### Exposing it

**Cloudflare Tunnel** is the easy path — no port forwarding, no dynamic DNS, and
your home IP stays hidden. Caveat: the free plan caps request bodies at 100 MB,
so that is your effective upload ceiling.

**Port forward + DDNS** avoids that cap but publishes your home IP, and some ISPs
prohibit running servers on residential connections.

Either way your **upload bandwidth is the bottleneck** — every Discord embed is
someone pulling from your home uplink. Discord's scraper also times out, so a
large image on a slow link may fail to embed even though the link works.

## Layout

```
src/
  common/     mime allowlist, content sniffing, IDs, password hashing
  config/     env parsing, the derived-secret root
  db/         better-sqlite3 connection + schema
  storage/    encrypted-at-rest blobs, seekable range reads
  privacy/    metadata scrubbing, rate limiting, hashed client IDs, log redaction
  files/      serving, ranges, deletion, expiry, link unlocking
  upload/     multipart intake
  remote/     URL import (SSRF-guarded fetcher, extractors)
  stego/      LSB encode/decode + AES
  views/      server-rendered HTML (OpenGraph, unlock, end-to-end reader)
  admin/      panel, auth, library API
  meta/       robots.txt, oEmbed, health
  cleanup/    expiry sweep + orphaned-blob sweep
public/       upload UI and the end-to-end reader (plain HTML/CSS/JS)
tools/        admin password hashing
deploy/       Pi runbook, Cloudflare Tunnel script, systemd unit
```
