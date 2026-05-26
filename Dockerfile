# syntax=docker/dockerfile:1.7
# pc-work-monitor cloud API — Cloud Run / GCE 共用イメージ
# lib/server.ts を tsx で起動し PORT=8080 で listen

FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       openssl ca-certificates git curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- deps: 本番依存のみ ----
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---- runner: 実行イメージ ----
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY lib ./lib

EXPOSE 8080
CMD ["npx", "tsx", "lib/server.ts"]
