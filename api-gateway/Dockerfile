# Stages: dev (docker-compose.yaml) and prod (docker-compose.prod.yaml).
# The gateway is stateless: no Prisma, no DB.

FROM node:20-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM deps AS dev
COPY . .
EXPOSE 8081
CMD ["yarn", "-s", "dev"]

# tsc also copies src/config.json into dist/ (resolveJsonModule + it is imported).
FROM deps AS build
COPY . .
RUN yarn -s build

FROM base AS prod
ENV NODE_ENV=production
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8081
CMD ["node", "dist/index.js"]
