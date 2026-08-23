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
# Vangrail tegen ongeremde heap-groei: zonder cap leest Node op Fly de
# host-memory in plaats van de container-limiet, en laat z'n heap dus
# voorbij de 512mb van de VM groeien vóórdat GC-druk ontstaat.
#
# Deze flag zet alleen de old-space, niet het totale heap-plafond.
# Gemeten (node 24) komt er consistent ~192mb bij voor young generation
# + V8-overhead:
#
#   192 → 384mb heap-limit      320 → 512mb
#   256 → 448mb                 384 → 576mb  ← boven de VM-limiet
#
# 256 dus: plafond 448mb, en boven wat de scrapers realistisch nodig
# hebben. Gemeten op de zwaarste venue (Concertgebouw, 4460 sitemap-
# URLs): piek heapUsed 35mb, piek RSS 232mb. Zes gelijktijdige scrapers
# in hetzelfde proces landen daarmee rond 210mb heap — daar moet de cap
# boven liggen, anders ruilen we een container-OOM in voor een
# heap-OOM.
#
# EERLIJK: die 35mb zegt ook dat de heap vermoedelijk NIET de oorzaak is
# van de nachtelijke 502s. De 197mb tussen heap en RSS is native
# geheugen (sharp/resvg-buffers zitten buiten de heap) plus baseline.
# Deze cap is dus goedkope verzekering die een runaway-heap afvangt en
# een crash diagnostiseerbaar maakt (clean heap-OOM met stacktrace i.p.v.
# een stille SIGKILL), geen bewezen fix.
#
# ponytail: als de 502s blijven komen is de volgende stap `memory =
# "1024mb"` in fly.toml (RSS-gedreven OOM), niet deze waarde tweaken.
ENV NODE_OPTIONS="--max-old-space-size=256"
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/
COPY apps/api/src/db/migrations ./apps/api/src/db/migrations
COPY apps/api/static ./apps/api/static
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY pnpm-workspace.yaml package.json ./
EXPOSE 8787
CMD ["node", "apps/api/dist/index.js"]
