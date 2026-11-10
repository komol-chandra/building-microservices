# DEV image: source is bind-mounted over /app, tsx watches and reloads.
# (Phase 7 adds a multi-stage production image.)
FROM node:20-slim

# Prisma's query engine needs OpenSSL; slim images don't ship it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first → this layer is cached until package.json/yarn.lock change.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Generate the typed Prisma client into node_modules.
COPY prisma ./prisma
RUN yarn prisma generate

COPY . .

EXPOSE 4003
# Apply pending migrations, then start. `exec` makes node replace the shell (signals reach it).
CMD ["sh", "-c", "yarn -s prisma migrate deploy && exec yarn -s dev"]
