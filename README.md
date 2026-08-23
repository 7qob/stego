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
| `GET /r/:id` | Always raw bytes. |
| `GET /d/:id` | Raw bytes, forced download. |
| `POST /api/upload` | multipart, field name `file`. Returns links + delete token. |
| `DELETE /api/files/:id?token=` | Delete using the token from upload. |
| `GET /api/limits` | Max size and retention policy. |
| `POST /api/stego/encode` | `file` + `message` + optional `password` → PNG. |
| `POST /api/stego/decode` | `file` + optional `password` → `{ message }`. |
| `POST /api/stego/capacity` | `file` → how many bytes it can hide. |

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
defence-in-depth. And add rate limiting; an open uploader gets abused fast.

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
  common/     mime allowlist, ID generation, HTML escaping
  config/     env parsing
  db/         better-sqlite3 connection + schema
  files/      serving, deletion, expiry
  upload/     multipart intake
  stego/      LSB encode/decode + AES
  views/      server-rendered HTML (OpenGraph pages)
  cleanup/    hourly purge of expired files
public/       upload UI (plain HTML/CSS)
deploy/       Pi runbook, Cloudflare Tunnel script, systemd unit
```
