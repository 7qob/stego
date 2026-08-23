# syntax=docker/dockerfile:1

# Native modules for the Pi are resolved here, under emulation, so the Pi never
# needs a compiler. Debian rather than Alpine on purpose: better-sqlite3 and
# sharp both publish prebuilt glibc arm64 binaries, so this stage downloads
# instead of building. On musl, better-sqlite3 compiles from source and sharp
# warns that the allocator fragments badly under image workloads — the exact
# workload the stego endpoints are.
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Only a fallback: if a prebuilt binary is ever missing for this ABI, npm can
# still build it rather than failing the release.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force


# The TypeScript compile produces identical output on any architecture, so it
# runs natively on the x64 runner instead of inside QEMU.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# python3 and yt-dlp are here for the YouTube import path: yt-dlp resolves a
# progressive stream URL, which the app then downloads itself through
# remote/http.ts. Deliberately the unpinned "latest" release — YouTube breaks
# older yt-dlp builds every few months, and a pinned tag would rot into a
# thumbnail-only import. Set STEGO_YTDLP_ENABLED=0 to leave it unused.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates curl python3 \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod 0755 /usr/local/bin/yt-dlp \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    STEGO_DATA_DIR=/data

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# main.ts serves this from __dirname/../public, i.e. /app/public.
COPY public ./public

# config/config.ts puts uploads/ and stego.db under STEGO_DATA_DIR. That is the
# only path this container writes to, which is what lets compose mount the root
# filesystem read-only. uid 1000 matches the default Raspberry Pi OS user, so a
# bind-mounted SSD directory owned by that user is writable without chown.
RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 3000

# /api/limits is the cheapest proof the app is alive: no disk, no DB, no query.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/limits').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
