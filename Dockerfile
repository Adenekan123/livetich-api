# syntax=docker/dockerfile:1
# livetich-api — NestJS. Multi-stage: install → build → slim runtime.

# ---- deps: install all deps once (cached on lockfile) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build: prisma client + compile TS ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# openssl so `prisma generate` detects the OpenSSL version correctly (the slim
# image omits it; without it Prisma picks the wrong engine → runtime mismatch).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate && pnpm build

# ---- runner: dist + node_modules (keeps the prisma CLI for migrate deploy
#      and the native @node-rs/bcrypt binary built for this platform) ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# openssl: Prisma query engine. curl: container HEALTHCHECK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
EXPOSE 3000
# Apply any pending migrations (idempotent), then boot.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main.js"]
