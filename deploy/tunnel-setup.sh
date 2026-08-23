#!/usr/bin/env bash
#
# One-shot Cloudflare Tunnel setup for stego. Run this on the Pi.
#
#   ./deploy/tunnel-setup.sh stego.example.com
#   ./deploy/tunnel-setup.sh stego.example.com my-tunnel http://localhost:3000
#
# What it does, in order:
#   1. installs cloudflared from Cloudflare's apt repo, if missing
#   2. logs in to your Cloudflare account (browser, once)
#   3. creates a named tunnel and its credentials
#   4. writes /etc/cloudflared/config.yml routing <hostname> to the app
#   5. creates the DNS record  <-- asks first; this is the outward-facing step
#   6. installs and starts the cloudflared systemd service
#
# Requirements: the domain's nameservers already point at Cloudflare, and you
# can open a URL in a browser once (any machine — the Pi need not have one).
#
# Set ASSUME_YES=1 to skip the prompts.

set -euo pipefail

TARGET_HOSTNAME="${1:-}"
TUNNEL_NAME="${2:-stego}"
ORIGIN_URL="${3:-http://localhost:3000}"

ASSUME_YES="${ASSUME_YES:-0}"

die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  local reply
  read -r -p "    $1 [y/N] " reply </dev/tty
  [[ "$reply" =~ ^[Yy]$ ]]
}

if [ -z "$TARGET_HOSTNAME" ]; then
  die "usage: $0 <hostname> [tunnel-name] [origin-url]
       e.g.  $0 stego.example.com"
fi

case "$TARGET_HOSTNAME" in
  *.*) ;;
  *) die "'$TARGET_HOSTNAME' does not look like a hostname (expected e.g. stego.example.com)" ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  die "run this as your normal user, not root — it calls sudo where it needs to.
       'cloudflared tunnel login' stores a certificate under \$HOME, and running
       the whole script as root puts it somewhere you will not find later."
fi

command -v sudo    >/dev/null || die "sudo not found"
command -v curl    >/dev/null || die "curl not found — sudo apt install curl"
command -v python3 >/dev/null || die "python3 not found — needed to read the tunnel list"

# ---------------------------------------------------------------------------

step "1/6  cloudflared"

if command -v cloudflared >/dev/null; then
  note "already installed: $(cloudflared --version 2>&1 | head -1)"
else
  note "not installed. Cloudflare's apt repo carries an arm64 build, which also"
  note "means 'apt upgrade' keeps it current."
  confirm "Install cloudflared from pkg.cloudflare.com?" || die "aborted"

  sudo mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y cloudflared
  note "installed: $(cloudflared --version 2>&1 | head -1)"
fi

# ---------------------------------------------------------------------------

step "2/6  Cloudflare account login"

CERT="$HOME/.cloudflared/cert.pem"
if [ -f "$CERT" ]; then
  note "already authorised ($CERT)"
else
  note "cloudflared will print a URL. Open it in any browser, sign in, and pick"
  note "the zone this hostname belongs to. It writes $CERT."
  cloudflared tunnel login
  [ -f "$CERT" ] || die "login did not produce $CERT"
fi

# ---------------------------------------------------------------------------

step "3/6  tunnel '$TUNNEL_NAME'"

# cloudflared's JSON output is not reliably clean: some versions print notices
# (an upgrade warning, for one) to stdout ahead of the array, and key casing has
# changed across releases. Skip to the first '[' and match keys
# case-insensitively, so a cosmetic banner cannot fail a deploy.
tunnel_id() {
  cloudflared tunnel list --output json 2>/dev/null | python3 -c '
import json, sys

name = sys.argv[1]
raw = sys.stdin.read()

start = raw.find("[")
if start == -1:
    sys.exit(0)
try:
    tunnels = json.loads(raw[start:])
except Exception:
    sys.exit(0)


def get(t, key):
    for k, v in t.items():
        if k.lower() == key:
            return v
    return None


for t in tunnels:
    if get(t, "name") == name and not get(t, "deleted_at"):
        print(get(t, "id") or "")
        break
' "$1"
}

# TUNNEL_ID can be set in the environment to bypass the lookup entirely.
TUNNEL_ID="${TUNNEL_ID:-$(tunnel_id "$TUNNEL_NAME")}"

if [ -n "$TUNNEL_ID" ]; then
  note "exists: $TUNNEL_ID"
else
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$(tunnel_id "$TUNNEL_NAME")"
  [ -n "$TUNNEL_ID" ] || die "tunnel '$TUNNEL_NAME' was created, but its ID could not be read back
       from 'cloudflared tunnel list'. The tunnel itself is fine — only the
       lookup failed. Copy the ID from the 'Created tunnel' line above and
       rerun, which skips the lookup:

         TUNNEL_ID=<the-uuid> $0 $TARGET_HOSTNAME $TUNNEL_NAME"
  note "created: $TUNNEL_ID"
fi

CREDS_SRC="$HOME/.cloudflared/$TUNNEL_ID.json"
[ -f "$CREDS_SRC" ] || die "credentials file $CREDS_SRC is missing.
       If this tunnel was created on another machine, copy that file here first."

# ---------------------------------------------------------------------------

step "4/6  /etc/cloudflared/config.yml"

sudo mkdir -p /etc/cloudflared

# The credentials file is the tunnel's private key: anyone holding it can serve
# traffic on your hostname. Root-owned and 0600 so the service can read it and
# nothing else on the Pi can.
sudo install -o root -g root -m 600 "$CREDS_SRC" "/etc/cloudflared/$TUNNEL_ID.json"

sudo tee /etc/cloudflared/config.yml >/dev/null <<CONFIG
# Generated by deploy/tunnel-setup.sh. Edit freely; rerunning overwrites it.

tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/$TUNNEL_ID.json

originRequest:
  # A home uplink is slow and the origin is a Pi writing to a USB SSD. Give it
  # room before the edge decides the origin is dead and returns a 502.
  connectTimeout: 30s

ingress:
  - hostname: $TARGET_HOSTNAME
    service: $ORIGIN_URL

  # Anything else arriving on this tunnel is not for us.
  - service: http_status:404

# Loopback only. 'curl 127.0.0.1:20241/ready' says whether the edge connections
# are actually up, which is the first thing to check when the hostname 502s.
metrics: 127.0.0.1:20241
CONFIG

note "written. Validating..."
cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
cloudflared --config /etc/cloudflared/config.yml tunnel ingress rule "https://$TARGET_HOSTNAME/f/abc123"

# ---------------------------------------------------------------------------

step "5/6  DNS record"

note "This creates a proxied CNAME for $TARGET_HOSTNAME pointing at"
note "$TUNNEL_ID.cfargotunnel.com in your Cloudflare zone."
note "It is a live, public DNS change on your domain."
note "If a record for that name already exists this fails rather than clobbering"
note "it — rerun with --overwrite-dns yourself if replacing is what you meant."

if confirm "Create the DNS record now?"; then
  if cloudflared tunnel route dns "$TUNNEL_NAME" "$TARGET_HOSTNAME"; then
    note "created"
  else
    note "route dns failed — most often because $TARGET_HOSTNAME already exists."
    note "Check it in the dashboard, or:"
    note "  cloudflared tunnel route dns --overwrite-dns $TUNNEL_NAME $TARGET_HOSTNAME"
  fi
else
  note "skipped. Point $TARGET_HOSTNAME at $TUNNEL_ID.cfargotunnel.com yourself"
  note "(CNAME, proxied), or rerun this script."
fi

# ---------------------------------------------------------------------------

step "6/6  systemd service"

if systemctl cat cloudflared.service >/dev/null 2>&1; then
  note "cloudflared.service already installed; restarting to pick up the config"
  sudo systemctl restart cloudflared
else
  # With /etc/cloudflared/config.yml present and no token argument, this
  # installs a unit that runs the tunnel from that file.
  sudo cloudflared service install
  sudo systemctl enable --now cloudflared
fi

sleep 3
systemctl --no-pager --lines=10 status cloudflared || true

# ---------------------------------------------------------------------------

printf '\n\033[1mDone.\033[0m\n'
cat <<SUMMARY

  tunnel      $TUNNEL_NAME ($TUNNEL_ID)
  hostname    https://$TARGET_HOSTNAME
  origin      $ORIGIN_URL

Next, so share links point at the right place:

  1. In .env next to docker-compose.yml:

       STEGO_BASE_URL=https://$TARGET_HOSTNAME

  2. Start (or restart) the app:

       docker compose up -d

  3. Check it end to end:

       curl -s https://$TARGET_HOSTNAME/api/limits

Useful afterwards:

  journalctl -u cloudflared -f            tunnel logs
  curl -s 127.0.0.1:20241/ready           are edge connections up
  cloudflared tunnel info $TUNNEL_NAME    which datacentres it is connected to

SUMMARY
