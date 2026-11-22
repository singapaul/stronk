# syntax=docker/dockerfile:1

# --- deps: production node_modules only (Bun runs the TypeScript directly, no build step)
FROM oven/bun:1.3.11 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Optional extra CA for networks that intercept TLS (e.g. a corporate proxy):
#   docker build --secret id=ca,src=/path/to/root-ca.pem -t stronk .
# It is mounted for this step only and never ends up in an image layer.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then CA="--cafile=/run/secrets/ca"; fi; \
    bun install --frozen-lockfile --production $CA

# --- web: build the PWA (needs dev dependencies: vite, preact preset, PWA plugin)
FROM oven/bun:1.3.11 AS web
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then CA="--cafile=/run/secrets/ca"; fi; \
    bun install --frozen-lockfile $CA
COPY web ./web
RUN bun run web:build

# --- litestream binary for continuous SQLite replication
FROM litestream/litestream:0.5.18 AS litestream

# --- runtime
FROM oven/bun:1.3.11-slim
WORKDIR /app
# ca-certificates: Litestream's TLS to S3/R2. sqlite3: manual backups and inspection.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates sqlite3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY litestream.yml /etc/litestream.yml
COPY src ./src
COPY data/exercises.json ./data/exercises.json
COPY --from=web /app/web/dist ./web/dist
COPY scripts/start.sh scripts/backup.sh ./scripts/

ENV NODE_ENV=production \
    DB_PATH=/data/gym.db \
    PORT=3000
EXPOSE 3000
# Migrations and the exercise seed run inside the app on boot.
CMD ["sh", "scripts/start.sh"]
