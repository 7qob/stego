# Deploying stego on a Raspberry Pi 5

GitHub Actions builds the arm64 image on every push touching `src/`, `public/`
or the packaging files, and publishes it to GHCR. The Pi pulls it and never
builds anything itself — which matters, because `better-sqlite3` and `sharp` are
native modules and compiling them on the Pi is slow and needs a toolchain.

```
push to main  ->  .github/workflows/image.yml  ->  ghcr.io/7qob/stego:latest
                                                          |
                                    docker compose pull   v
                                                        the Pi
```

Two things to decide before you start:

- **Where the data lives.** A USB SSD, never the SD card. A file host writes
  constantly and will chew through SD flash.
- **How it gets exposed.** Cloudflare Tunnel is the easy path; the caveat is a
  100 MB request-body cap on the free plan, which becomes your upload ceiling.

---

## 1. One-time Pi setup

Docker, if it is not there yet:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in so the group takes effect.

The data directory on the SSD. The container runs as uid 1000, the same as the
default Pi user, so a directory you own needs no `chown`:

```bash
sudo mkdir -p /mnt/ssd/stego
sudo chown "$(id -u):$(id -g)" /mnt/ssd/stego
```

Then get the compose file onto the Pi:

```bash
git clone https://github.com/7qob/stego.git ~/stego
```

Only `docker-compose.yml` and `.env` are actually used at runtime — the source
is along for the ride so `git pull` keeps the compose file current.

## 2. Make the GHCR package pullable

**This is the step that catches everyone.** The first push publishes the package
as **private**, and `docker compose pull` on the Pi will fail with
`denied` or `manifest unknown` even though the workflow succeeded.

Either make it public — <https://github.com/users/7qob/packages/container/stego/settings>
→ *Change visibility* → Public — or keep it private and log the Pi in with a
personal access token that has `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u 7qob --password-stdin
```

Public is fine here: the image contains no secrets, only the compiled app.

## 3. Configure

```bash
cd ~/stego
cp .env.example .env
```

The values that matter in `.env`:

| Variable | Notes |
| --- | --- |
| `STEGO_BASE_URL` | **Required.** The URL Discord will actually fetch, e.g. `https://stego.example.com`. Wrong here and every share link points somewhere that does not exist. |
| `STEGO_HOST_DATA_DIR` | Host path for uploads + `stego.db`. Default `/mnt/ssd/stego`. |
| `STEGO_MAX_FILE_SIZE` | Defaults to 95 MB, just under Cloudflare's free-plan cap. |
| `STEGO_RETENTION_DAYS` | `0` keeps files forever. |

## 4. Run

```bash
docker compose pull && docker compose up -d
```

Check it:

```bash
curl -s localhost:3000/api/limits
docker compose logs -f stego
```

The port is published on `127.0.0.1` only. Nothing outside the Pi can reach it
until the tunnel is up, which is deliberate — an open uploader with no rate
limiting should not be exposed a moment earlier than you intend.

## 5. Cloudflare Tunnel

### Scripted (recommended)

Requires the domain's nameservers to already point at Cloudflare.

```bash
./deploy/tunnel-setup.sh stego.example.com
```

It installs `cloudflared` from Cloudflare's apt repo, walks you through the
one-time browser login, creates the tunnel, writes `/etc/cloudflared/config.yml`
routing your hostname to `http://localhost:3000`, creates the DNS record (it
asks first — that is the public, outward-facing step), and installs the systemd
service.

Then put the hostname in `.env` and restart:

```bash
sed -i 's|^STEGO_BASE_URL=.*|STEGO_BASE_URL=https://stego.example.com|' .env
docker compose up -d
```

### Dashboard instead

If you would rather click through Zero Trust → Networks → Tunnels: create the
tunnel there, point its public hostname at `http://stego:3000`, copy the
connector token into `.env` as `TUNNEL_TOKEN`, and bring cloudflared up as a
container alongside the app:

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

Routing then lives in Cloudflare's UI rather than in a file you can read. Use
one path or the other — running both means two connectors fighting over the
same hostname.

### Cloudflare settings that will bite you

- **Bot Fight Mode blocks Discord's scraper.** If links stop embedding but work
  in a browser, this is why. Security → Bots → off, or add a WAF skip rule for
  `Discordbot` on `/f/*`.
- **100 MB request bodies** on Free and Pro. The upload fails at the edge before
  it ever reaches the Pi. Business raises it to 200 MB. Chunked uploads are the
  real fix and are not built yet.
- **Cache the file routes.** Every Discord embed is someone pulling from your
  home uplink. A cache rule on `/f/*` and `/r/*` with an Edge TTL of a few hours
  moves most of that to Cloudflare. Do *not* cache `/api/*`.
- **Under Attack mode breaks everything non-browser** — scrapers, `curl`, the
  API. Leave it off.

## 6. Updating

CI publishes on push. On the Pi:

```bash
cd ~/stego && ./deploy/update.sh
```

That pulls the compose file, pulls the image, restarts, waits on the
container's `HEALTHCHECK`, and checks `STEGO_BASE_URL/api/limits` through the
tunnel. **If the new image fails its healthcheck it rolls back to the image
that was running before** — an update that breaks the container should not also
leave it broken.

It exits early if the pulled image is identical to the running one. That is
usually not an error: the `paths:` filter on the workflow means a push touching
only docs or `deploy/` publishes nothing. Check the Actions tab, or use
`./deploy/update.sh --force` to redeploy the same image anyway.

The equivalent by hand, if you would rather watch each step:

```bash
cd ~/stego && git pull && docker compose pull && docker compose up -d
```

`git pull` is only for the compose file; the app itself comes from the image.
Old images accumulate — `docker image prune -f` occasionally.

To roll back, pin the short SHA tag that CI also publishes:

```bash
STEGO_IMAGE=ghcr.io/7qob/stego:sha-1a2b3c4 docker compose up -d
```

## 7. Troubleshooting

| Symptom | Check |
| --- | --- |
| `docker compose pull` → `denied` | Package is still private. See step 2. |
| Hostname returns 502 | `curl -s 127.0.0.1:20241/ready` — are edge connections up? Then `docker compose ps` — is the app healthy? |
| Hostname returns 404 | Tunnel is up but the ingress hostname does not match. `cloudflared --config /etc/cloudflared/config.yml tunnel ingress rule https://your.host/` |
| Links point at `localhost` | `STEGO_BASE_URL` is wrong. It is baked into responses at request time, so fix `.env` and `docker compose up -d`. |
| Container restarts on boot with a read-only error | `STEGO_HOST_DATA_DIR` is not writable by uid 1000, or the SSD did not mount before Docker started. Add the mount to `/etc/fstab` with `nofail`. |
| Discord shows no embed | Bot Fight Mode (above), or the file is large enough that the scraper timed out. Thumbnails would fix the latter and are not built yet. |

## Without Docker

`stego.service` in this directory runs the app straight from a build on the Pi —
`npm ci && npm run build`, then systemd. It is the fallback if you would rather
not run Docker; everything above about the SSD, `STEGO_BASE_URL` and the tunnel
still applies. The tunnel script does not care which one you use, as long as
something is listening on `http://localhost:3000`.
