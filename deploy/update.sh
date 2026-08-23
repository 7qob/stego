#!/usr/bin/env bash
#
# Pull the newest published image and restart stego. Run this on the Pi:
#
#   cd ~/stego && ./deploy/update.sh
#   ./deploy/update.sh --force     # redeploy even if the image is unchanged
#
# Nothing is built here. CI publishes ghcr.io/7qob/stego:latest and this only
# pulls it, which is the whole point — better-sqlite3 and sharp are native
# modules and compiling them on a Pi is slow.
#
# If the new image fails its healthcheck, this rolls back to the image that was
# running before. An update that breaks the container should not also leave it
# broken.

set -euo pipefail

cd "$(dirname "$0")/.."

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

[ -f .env ] || die ".env not found. Copy .env.example and set STEGO_BASE_URL."

# The public URL, so the final check goes through the tunnel rather than just
# hitting loopback. A container that is healthy but unreachable is still down.
BASE_URL="$(grep -E '^STEGO_BASE_URL=' .env | tail -1 | cut -d= -f2-)"

# ---------------------------------------------------------------------------

step "1/5  compose file"

# The image comes from GHCR; this pull is only so docker-compose.yml and the
# deploy scripts stay current.
git pull --ff-only

# ---------------------------------------------------------------------------

step "2/5  pull image"

# Image ID of what is running now. This is the rollback target, and comparing
# it afterwards is how we know whether the pull actually brought anything new.
BEFORE="$(docker inspect -f '{{.Image}}' stego 2>/dev/null || echo '')"

docker compose pull

AFTER="$(docker compose config --images | head -1)"
AFTER="$(docker image inspect -f '{{.Id}}' "$AFTER" 2>/dev/null || echo '')"

if [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ] && [ "$FORCE" = "0" ]; then
  note "already running the newest published image."
  note "CI skips the build when a push touches only docs or deploy/ — check the"
  note "Actions tab if you expected a new one. Rerun with --force to redeploy."
  exit 0
fi

# ---------------------------------------------------------------------------

step "3/5  restart"

docker compose up -d

# ---------------------------------------------------------------------------

step "4/5  wait for healthcheck"

# The Dockerfile's HEALTHCHECK has a 20s start period, so give it room.
healthy=0
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' stego 2>/dev/null || echo 'missing')"
  case "$status" in
    healthy)   healthy=1; break ;;
    unhealthy) break ;;
  esac
  sleep 2
done

if [ "$healthy" != "1" ]; then
  note "container did not become healthy. Last 40 log lines:"
  docker compose logs --tail=40 stego || true

  if [ -n "$BEFORE" ]; then
    step "rolling back to $BEFORE"
    STEGO_IMAGE="$BEFORE" docker compose up -d
    note "rolled back. The bad image is still pulled locally; investigate with:"
    note "  docker compose logs stego"
  else
    note "no previous image to roll back to."
  fi
  die "update failed"
fi

note "healthy"

# ---------------------------------------------------------------------------

step "5/5  verify through the tunnel"

code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/limits" || echo '000')"
if [ "$code" = "200" ]; then
  note "$BASE_URL/api/limits -> 200"
else
  note "$BASE_URL/api/limits -> $code"
  note "The container is healthy, so this is the tunnel rather than the app:"
  note "  curl -s 127.0.0.1:20241/ready       are edge connections up"
  note "  systemctl status cloudflared"
fi

printf '\n\033[1mDone.\033[0m  %s\n' "$(docker compose images stego | tail -1)"
note "old images accumulate: docker image prune -f"
