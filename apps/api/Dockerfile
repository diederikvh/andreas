# syntax=docker/dockerfile:1.6
# Multi-stage build voor @andreas/api. Wordt door Fly gebouwd vanaf
# de repo-root (zie fly.toml `dockerfile` pad). Hoisted-pnpm-layout:
# alle deps landen in de root node_modules, geen per-package linker.

ARG NODE_VERSION=20-alpine

# ── Base stage ────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── Deps stage — installeert alleen api-relevante deps ───────────
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @andreas/api...

# ── Build stage — compileert TS naar dist/ ───────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
RUN pnpm --filter @andreas/api exec tsc

# ── Runtime stage — minimal image, alleen wat nodig is ───────────
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/
COPY apps/api/src/db/migrations ./apps/api/src/db/migrations
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY pnpm-workspace.yaml package.json ./
EXPOSE 8787
CMD ["node", "apps/api/dist/index.js"]
