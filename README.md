# Off-Air Memory — Server

NestJS API for **Off-Air Memory**: archive of childhood TV channels (Cartoon Network, Nickelodeon, Jetix, Adult Swim). Scans a media folder, stores channels / cartoons / episodes, builds a daily “on-air” schedule, and serves video files as static media for an Angular TV-style frontend.

## Quick start

```powershell
bun install
# copy .env.example → .env and fill DB + MEDIA_ROOT
bun run start:dev
```

- API: `http://localhost:3000/api`
- Swagger: `http://localhost:3000/docs`
- Media: `http://localhost:3000/media/...` (from `MEDIA_ROOT`)
- App static: `http://localhost:3000/static/...`

## Environment

See [`.env.example`](./.env.example). Important:

| Variable | Purpose |
|----------|---------|
| `DB_*` | MariaDB connection |
| `MEDIA_ROOT` | Root of cartoon library (e.g. `X:/`) |
| `SCAN_ON_BOOT` | Run media scan on process start (`false` in watch mode) |
| `JWT_KEY` / `TOKEN_TIME` | Auth cookies |
| `FRONT_URL` | Angular app origin for CORS |

## Media layout on disk

```
MEDIA_ROOT/
  cartoon-network/
    adventure-time/
      s1/1.mp4
      specials/SomeMovie.mp4
  nickelodeon/
  jetix/
  adult-swim/
```

Scan: `POST /api/media/scan` · status: `GET /api/media/status`

## Main modules

| Path | Role |
|------|------|
| `auth/` | Login / logout / cookie JWT |
| `resources/user/` | User, profile, credentials |
| `resources/channels/` | Channel, cartoon, episode + media scan |
| `resources/schedule-day/` | Daily playlist (`ScheduleDay` / `ScheduleItem`) |
| `resources/broadcast/` | Holiday tags & calendar windows |
| `db/` | TypeORM MariaDB + SQLite (JWT blacklist) |
| `jwt/` | Tokens + blacklist |

## Scripts

```powershell
bun run start:dev      # SWC watch
bun run build          # SWC build → dist/
bun run start:prod     # node dist/main.js
bun run docs:typedoc
bun run docs:compodoc
```

Swagger UI: open `/docs` while the server is running.

## Documentation tools

### Swagger
With server running: [http://localhost:3000/docs](http://localhost:3000/docs)

### TypeDoc
```powershell
bun run docs:typedoc
start docs/typedoc/index.html
```

### Compodoc
```powershell
bun run docs:compodoc
```

## Deployment (short)

1. Set `.env` / `.env.production` (`MEDIA_ROOT` must be visible to the process).
2. `bun install && bun run build`
3. PM2: edit `ecosystem.config.js` name, then `pm2 start ecosystem.config.js`

Nginx: proxy `/api` and `/media` to the Nest process; serve Angular separately or from another `root`.

```nginx
location /api {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /media {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
}
```

## Tech stack

- NestJS, TypeScript, TypeORM
- MariaDB (channels / schedule / users) · SQLite (token blacklist)
- Winston, Throttler, Helmet, Swagger
- Package manager: Bun (also works with npm/pnpm)

## Architecture notes

- **`DefaultCRUDService`** — shared CRUD / search / pagination
- **Global `AuthGuard`** — cookie JWT; use `@Public()` for open routes
- **Schedule** — build once per channel/day; frontend seeks by sum of `durationSec` from window start (e.g. 08:00)
- **Broadcast tags** — holiday boost/exclude rules (not franchise chronology; that lives on `ChannelCartoon.franchiseKey` / `eraOrder`)
