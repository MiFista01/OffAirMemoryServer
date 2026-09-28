# Deploy Off-Air Memory

Файл: [`nginx.conf`](./nginx.conf) — по образцу `crime-nodejs-copy/www/nginx.conf`.

Quick start:

1. `docker compose -f docker-compose.build.yml build`
2. `docker save …` → NAS → `docker load`
3. Edit `DB_*` / `JWT_*` / `FRONT_URL` in compose
4. `docker compose up -d`

HLS: Nest writes to `STREAM_ROOT` (`/data/stream`); nginx www reads the same volume. `NGINX_ON=true`.
