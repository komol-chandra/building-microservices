# One Dockerfile, several stages. Compose picks one with `build.target`:
#   dev  → docker-compose.yaml       (source bind-mounted, tsx watch, live reload)
#   prod → docker-compose.prod.yaml  (compiled JS, production deps only, non-root)

# ---------- base: what every stage needs ----------
FROM node:20-slim AS base
# Prisma's query engine needs OpenSSL; slim images don't ship it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------- deps: ALL dependencies (incl. TypeScript, tsx) + generated Prisma client ----------
FROM base AS deps
# Copy only the manifests first → this layer is cached until package.json/yarn.lock change.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY prisma ./prisma
RUN yarn prisma generate

# ---------- dev ----------
FROM deps AS dev
COPY . .
EXPOSE 4003
# Apply pending migrations, then start. `exec` makes node replace the shell (signals reach it).
CMD ["sh", "-c", "yarn -s prisma migrate deploy && exec yarn -s dev"]

# ---------- build: compile TypeScript → dist/ ----------
FROM deps AS build
COPY . .
RUN yarn -s build

# ---------- prod: small runtime image ----------
FROM base AS prod
ENV NODE_ENV=production
# Production deps only (no TypeScript, tsx, @types). `prisma` is a runtime dependency
# on purpose: the container runs `prisma migrate deploy` when it starts.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean
COPY prisma ./prisma
RUN yarn prisma generate
COPY --from=build /app/dist ./dist
# Don't run as root. The `node` user ships with the official image.
USER node
EXPOSE 4003
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/index.js"]
