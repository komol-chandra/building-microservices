# DEV image (no Prisma, no DB: the gateway is stateless).
FROM node:20-slim
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
EXPOSE 8081
CMD ["yarn", "-s", "dev"]
