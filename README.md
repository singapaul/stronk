# stronk

A personal API for logging gym lifts. It's a single Bun + Hono service backed by one SQLite file, with a REST API behind basic auth and an MCP endpoint, so Claude can search exercises, log sets, read history and plan sessions.

- **Exercises:** 876 from [free-exercise-db](https://github.com/yuhonas/free-exercise-db) (public domain), vendored in `data/` and seeded on first boot. Nothing calls an outside API at runtime.
- **Workouts:** one workout per training day (Europe/London, with the day rolling over at 04:00). Exercises in a workout are grouped into blocks with notes, supersets and rest times. Sets are typed `warmup | normal | failure | dropset`.
- **Planning:** you can save reusable routines with rep ranges, or plan a one-off session. Planned sets stay planned until performed, and `log_set` fills them in order while keeping the targets.
- **Stats:** history per exercise, PRs (heaviest, Epley e1RM, best reps at each weight), and a weekly summary with per-muscle set counts. Bodyweight logging gives pull-ups and dips their real load.
- **Units:** everything is in kilograms.

## Local setup

```bash
bun install
cp .env.example .env          # fill in the four auth values
bun run dev                   # http://localhost:3000, migrates + seeds on boot
```

Generate tokens with `openssl rand -hex 32`. The app refuses to start if any auth variable is missing, if a token is shorter than 32 characters, or if the two tokens are the same.

| Variable | Purpose |
|---|---|
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` | REST credentials. MCP also accepts them. |
| `MCP_TOKEN` | Bearer token for MCP clients that can send headers (Claude Code) |
| `MCP_PATH_TOKEN` | Secret URL segment for the Claude app (`/mcp/<token>`) |
| `DB_PATH` | SQLite file (default `./data/gym.db`, `/data/gym.db` in the container) |
| `PORT` | Default `3000` |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_S` | Default 300 requests per 300 s, per credential type and client IP |
| `LITESTREAM_*` | Optional continuous backup (see [Backups](#backups)) |

Scripts:

```bash
bun test                      # in-memory SQLite per test
bun run typecheck
bun run seed --refresh        # upsert the latest dataset; custom exercises, sets and type fixes are kept
bun run fetch-exercises       # re-download free-exercise-db into data/exercises.json (then commit it)
```

## Connecting Claude

**Claude Code** (sends a header):

```bash
claude mcp add --transport http gym https://<host>/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

**Claude app**: go to Settings → Connectors → Add custom connector and enter `https://<host>/mcp/<MCP_PATH_TOKEN>`.

Custom connectors can't send static headers, so for the Claude app the secret sits in the URL. That's weaker than a header, because URLs end up in history and screenshots. The app redacts the path token from its own request logs, and it's a separate token from `MCP_TOKEN`, so you can rotate it on its own. OAuth 2.1 is the proper fix and is planned. All auth lives in `src/auth.ts` so it can be swapped out.

Smoke test with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "Authorization: Bearer $MCP_TOKEN" --method tools/list
```

### MCP tools

| Tool | What it does |
|---|---|
| `search_exercises` | Find exercise ids by name, muscle, equipment, level, category or type. Lifts you've logged rank first. |
| `get_exercise` | Full details, instructions and images |
| `create_custom_exercise` | Add an exercise the library is missing (`custom_<slug>`) |
| `log_set` | Log one set. It goes to today's workout by default and fills the next planned set. Returns PR flags and the next target. |
| `log_workout` | Log a whole session (blocks of sets), merging into that day |
| `complete_planned_set` | Record actual numbers for one specific planned set |
| `update_set` / `delete_set` | Fix mistakes. Deleting renumbers the remaining sets. |
| `get_workout` | One day's workout, including set ids |
| `get_history` | Recent sessions for an exercise: top set, volume, e1RM |
| `get_recent_workouts` | The last N days (and planned days), one line per exercise |
| `get_prs` | Personal records |
| `plan_session` | Save target sets for a day |
| `list_routines` / `get_routine` / `create_routine` / `update_routine` | Reusable templates |
| `start_routine` | Copy a routine into a day as planned sets |
| `log_bodyweight` / `get_bodyweight` | Bodyweight entries |

The server instructions tell Claude that weights are in kg, that it should search before logging, and that it should read history before planning and apply progressive overload to the real numbers.

## REST API

All routes under `/api` need basic auth. Bodies are JSON and validated with Zod. Errors look like `{ "error": string, "details"?: any }`. An unknown `exercise_id` returns 404 with the five closest matches in `details.suggestions`.

| Method & path | Notes |
|---|---|
| `GET /health` | No auth. Returns `{ "ok": true }` |
| `GET /api/exercises?q=&muscle=&equipment=&level=&category=&type=&limit=&offset=` | Search |
| `GET /api/exercises/:id` | Detail, with image URLs |
| `POST /api/exercises` | Create a custom exercise |
| `PATCH /api/exercises/:id` | Custom exercises: any field. Library exercises: `type` only (survives `seed --refresh`). |
| `GET /api/exercises/:id/history?limit=&from=&to=&format=sessions\|sets` | |
| `POST /api/workouts` | `{ date?, name?, notes?, start_time?, end_time?, exercises?: [{ exercise_id, notes?, superset_group?, rest_seconds?, sets: [...] }] }`. Merges into that day. |
| `POST /api/workouts/plan` | Same shape as `plan_session` |
| `GET /api/workouts?from=&to=&updated_since=&limit=&offset=` | |
| `GET /api/workouts/today`, `GET /api/workouts/by-date/:date`, `GET /api/workouts/:id` | Detail: blocks, sets, derived status/timing, totals |
| `PATCH /api/workouts/:id`, `DELETE /api/workouts/:id` | |
| `PATCH /api/workout-exercises/:id` | Block notes, superset, rest, position |
| `POST /api/sets` | `{ exercise_id, reps?, weight_kg?, duration_s?, distance_m?, rpe?, type?, notes?, workout_id?, date? }` |
| `POST /api/sets/:id/complete`, `PATCH /api/sets/:id`, `DELETE /api/sets/:id` | |
| `GET/POST /api/routines`, `GET/PATCH/DELETE /api/routines/:id`, `POST /api/routines/:id/start` | |
| `GET /api/bodyweight?from=&to=`, `PUT/DELETE /api/bodyweight/:date` | |
| `GET /api/prs?exercise_id=`, `GET /api/summary?from=&to=`, `GET /api/recent?days=` | |

How the derived values work:

- **Workout status:** `planned` means nothing performed yet. `in_progress` means it's today and has performed sets. `completed` means a past day with performed sets. Planned sets left over on a past day are marked `skipped`.
- **Timing:** start and end times come from when sets were logged, unless they were given explicitly (for backfills).
- **Working sets:** performed, not a warm-up, with reps.
- **Volume:** reps × load over working sets.
- **e1RM and heaviest:** Epley `load × (1 + reps/30)`, with dropsets excluded.
- **Bodyweight exercises:** load is your latest bodyweight plus `weight_kg` (negative means assistance).

## Deploy (Fly.io)

```bash
fly launch --no-deploy --copy-config        # pick an app name; keep the volume mount
fly volumes create gym_data --size 1 --region lhr
fly secrets set BASIC_AUTH_USER=... BASIC_AUTH_PASS=... \
  MCP_TOKEN=$(openssl rand -hex 32) MCP_PATH_TOKEN=$(openssl rand -hex 32)
fly deploy
fly scale count 1                           # SQLite = one writer: never run more than one machine
```

TLS terminates at Fly (`force_https`). The image runs migrations and the seed on boot. `fly deploy` builds on Fly's remote builders, so a local Docker install isn't required.

### Building the image locally

```bash
docker build -t stronk .
```

On a network that intercepts TLS (a corporate proxy such as Cisco Umbrella or Zscaler), `bun install` inside the build fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Export the proxy's root CA and pass it as a build secret. It's used only for the install step and never stored in the image:

```bash
security find-certificate -a -p -c "Cisco Umbrella Root CA" /Library/Keychains/System.keychain > ~/proxy-ca.pem   # macOS
docker build --secret id=ca,src=$HOME/proxy-ca.pem -t stronk .
```

On any other small VPS, run the same image behind Caddy for automatic HTTPS:

```
gym.example.com {
  reverse_proxy localhost:3000
}
```

## Backups

**Option 1: Litestream to Cloudflare R2 (continuous; this is the recommended setup on Fly).** Create an R2 bucket and an API token with read/write access to that bucket, then:

```bash
fly secrets set LITESTREAM_BUCKET=gym-backups \
  LITESTREAM_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
  LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=...
```

When `LITESTREAM_BUCKET` is set, `scripts/start.sh` restores the DB from R2 if the volume is empty, then runs the app under `litestream replicate`, which streams every change to R2 within seconds. To recover onto a fresh volume, just deploy: the restore happens automatically. To pull a copy locally:

```bash
litestream restore -config litestream.yml -o ./restored.db /data/gym.db
```

**Option 2: nightly `sqlite3 .backup` (simplest on a VPS).** `scripts/backup.sh` takes a consistent online copy, checks its integrity and keeps the newest 14:

```
30 2 * * * DB_PATH=/data/gym.db BACKUP_DIR=/data/backups /app/scripts/backup.sh
```

Copy `BACKUP_DIR` off the machine (rclone, restic, etc.). A backup on the same disk doesn't protect against losing that disk.

## Project layout

```
src/
  index.ts          boot: env, DB, migrations, seed, serve
  app.ts            Hono app factory (routes, /mcp, error mapping)
  db.ts             connection, pragmas (WAL, foreign keys), migration runner
  migrations/       plain SQL, tracked in schema_migrations
  seed.ts           free-exercise-db import (+ CLI)
  auth.ts           basic auth, MCP token/path checks, rate limiter
  schemas.ts        Zod schemas shared by REST and MCP
  services/         all business logic + SQL (shared by REST and MCP)
  routes/           thin REST handlers
  mcp/              MCP server, tools and stateless transport
test/               bun test, in-memory DB per test
```
