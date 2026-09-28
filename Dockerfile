FROM oven/bun:1 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1

WORKDIR /app

ENV NODE_ENV=production

# HLS encode — without ffmpeg the stream will not start.
# intel-media-va-driver: iGPU VAAPI (DXP4800 Plus / Pentium 8505 UHD)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    intel-media-va-driver \
    vainfo \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 3000

CMD ["bun", "dist/main.js"]
