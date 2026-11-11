# Stages: dev (Vite dev server, hot reload) and prod (static files behind nginx).

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM deps AS dev
COPY . .
EXPOSE 5173
CMD ["yarn", "-s", "dev"]

# Vite inlines VITE_* variables at BUILD time, so the gateway URL is a build arg,
# not a runtime env var. Changing it means rebuilding the image.
FROM deps AS build
ARG VITE_API_URL=http://localhost:8081
ENV VITE_API_URL=$VITE_API_URL
COPY . .
RUN yarn -s build

FROM nginx:1.27-alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
