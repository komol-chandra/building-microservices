# Runs the end-to-end tests against a running stack, from INSIDE the compose network
# (it calls http://api-gateway:8081 like any client would).
#   docker compose --profile test run --rm e2e
FROM node:20-slim
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
CMD ["yarn", "-s", "test"]
