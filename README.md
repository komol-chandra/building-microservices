# Micro-Service Study: E-commerce on Docker

A small e-commerce system built to learn microservices hands-on. It has three Node.js services (Product, Inventory, Order) behind a custom API gateway. Each service has its own Postgres database. The services talk over HTTP and RabbitMQ, and a React client sits in front. Everything runs in Docker Compose.

It is based on the Stack Learner *Practical Microservices* course (the course PDF and the ER diagram are in the repo root). The full design is in [PLAN.md](PLAN.md), and the live build status and decision log are in [PROGRESS.md](PROGRESS.md).

> **Status:** Phases 0–9 are done: infrastructure, the product/inventory/order services, an auth-service (Phase 9), the API gateway, the RabbitMQ order saga, the React client, Docker polish (health checks, prod images, seed data), and the reliability stretch goals (retry + dead-letter queue, transactional outbox, correlation-id logging, unit + end-to-end tests). Next (optional): Email, Cart, Keycloak, Kong. See the [Roadmap](#roadmap).

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Request flows](#request-flows)
- [Messaging (RabbitMQ)](#messaging-rabbitmq)
- [Data model](#data-model)
- [API reference](#api-reference)
- [API gateway internals](#api-gateway-internals)
- [React client](#react-client)
- [Configuration](#configuration)
- [Failure scenarios to try](#failure-scenarios-to-try)
- [Design decisions](#design-decisions)
- [Gotchas and lessons learned](#gotchas-and-lessons-learned)
- [Known gaps](#known-gaps)
- [Sokrio takeaways](docs/sokrio-takeaways.md)
- [Tests](#tests)
- [Development workflow](#development-workflow)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)

---

## Quick start

You only need Docker. Node and yarn run inside the containers (the host's Node 18 is never used).

```bash
cp .env.example .env        # first time only
docker compose up -d        # build, start everything, and seed demo data
docker compose ps           # every app container shows "(healthy)"; seed shows "Exited (0)"
curl localhost:8081/health  # gateway + every service should be "up"
```

Then open **http://localhost:5173** and log in with one of the demo users (the login page has quick-fill buttons).

A one-shot `seed` container loads 8 demo products through the gateway on every `up`. It skips SKUs that already exist, so running it again changes nothing. A few of the products are there to show specific behaviour:

| SKU | Stock | Shows |
|---|---|---|
| `BOTTLE-750` | 3 | order 4+ → the saga ends `FAILED` |
| `CAP-BLK` | 0 | every order `FAILED` |
| `PROTO-01` | 5 | `DRAFT`: only admin sees it; ordering it → 400 |

### Production-like stack

The same system, built from the `prod` Dockerfile stages: compiled JS, production dependencies only, running as the non-root `node` user, no bind mounts, and the client as static files behind nginx.

```bash
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --build
```

[docker-compose.prod.yaml](docker-compose.prod.yaml) is an override: it changes the build target and removes the bind mounts (`!reset`, Compose ≥ 2.24), and inherits everything else. It still uses the dev passwords from `.env`, so it is for local testing only. Image sizes: about 770 MB per service in prod vs 1.87 GB in dev; the client is 74 MB vs 1.2 GB.

| What | URL | Login |
|---|---|---|
| React client | http://localhost:5173 | see [Demo users](#demo-users) |
| API gateway | http://localhost:8081/health | see [Demo users](#demo-users) |
| RabbitMQ management | http://localhost:15672 | `guest` / `guest` |
| Adminer (browse Postgres) | http://localhost:8080 | system `PostgreSQL`, server `postgres`, see [Database users](#database-users) |

### Demo users

These are seeded by auth-service's first migration (scrypt-hashed, same ids as before Phase 9). Anyone can also create an account at `/register` (always role `user`); an admin can promote users with `PUT /users/:id/role`.

| Email | Password | Role | Can do |
|---|---|---|---|
| `admin@shop.test` | `admin123` | admin | create/edit products, adjust stock, see stock history, place orders |
| `user@shop.test` | `user123` | user | browse published products, place and view their own orders |

### Database users

| Database | User | Password |
|---|---|---|
| `product_db` | `product_svc` | `product_pw` |
| `inventory_db` | `inventory_svc` | `inventory_pw` |
| `order_db` | `order_svc` | `order_pw` |
| `auth_db` | `auth_svc` | `auth_pw` |
| *(superuser)* | `postgres` | `postgres` |

These are development-only credentials. Each service user can connect **only** to its own database (`REVOKE CONNECT ... FROM PUBLIC` in [infra/postgres/init.sql](infra/postgres/init.sql)).

### Try it with curl

```bash
# log in as admin
TOKEN=$(curl -s -XPOST localhost:8081/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@shop.test","password":"admin123"}' | jq -r .accessToken)

# create a product with 5 in stock (product-service creates the inventory row for you)
PID=$(curl -s -XPOST localhost:8081/products -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"sku":"MUG-01","name":"Mug","price":"8.00","status":"PUBLISHED","quantity":5}' | jq -r .id)

# place an order: 201 with status PENDING, then it becomes CONFIRMED a moment later
OID=$(curl -s -XPOST localhost:8081/orders -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"items\":[{\"productId\":\"$PID\",\"quantity\":2}]}" | jq -r .id)
sleep 1; curl -s localhost:8081/orders/$OID -H "Authorization: Bearer $TOKEN" | jq .status

# stock is now available 3 / reserved 2
curl -s localhost:8081/inventories/product/$PID | jq
```

---

## Architecture

```
  Browser ──▶ client (React, :5173)
                 │  every API call goes through the gateway
                 ▼
            api-gateway (:8081)   JWT check (RS256 via JWKS) · routing · rate limit · adds x-user-* headers
             │        │        │        └──────────────▶ auth (:4004) ── auth_db
             ▼        ▼        ▼                         login/register, signs tokens, /.well-known/jwks.json
         product   inventory   order          (no host ports: Docker network only)
          :4001     :4002      :4003
             │  HTTP ─┘  ▲        │  HTTP (product snapshot)
             │           │        └──────────▶ product
             ▼           ▼        ▼
        product_db  inventory_db  order_db       (one Postgres container, 3 isolated DBs)
                         │        │
                         └─▶ RabbitMQ ◀─┘        exchange: ecommerce.events (topic)
```

| Service | Owns (tables) | Talks to |
|---|---|---|
| **product** | `Product` | inventory (sync HTTP: creates the stock row, reads stock) |
| **inventory** | `Inventory`, `StockHistory`, `ProcessedEvent` | consumes `order.placed`; publishes `inventory.reserved` / `inventory.failed` |
| **order** | `Order`, `LineItem`, `ProcessedEvent` | product (sync HTTP for the snapshot); publishes `order.placed`; consumes `inventory.*` |
| **auth** | `User`, `SigningKey` | nobody (others reach it through the gateway); signs RS256 tokens, publishes the public keys |
| **api-gateway** | nothing (no DB) | the only entry point for the UI; verifies JWTs with auth's public keys (can't create them) |
| **client** | nothing (cart in localStorage) | gateway only, from the browser |

### Key ideas this project demonstrates

- **One database per service.** Each service has its own database *and* its own Postgres user, so a service can't connect to another service's database. The database enforces this; it isn't just a convention.
- **No cross-service foreign keys.** `Product.inventoryId`, `Inventory.productId` and `LineItem.productId` are plain strings. The other table lives in another database.
- **Snapshot data.** An order line item copies the product's name, SKU and price, so the order history stays correct after a product changes or disappears.
- **Partial failure.** Product details still load with `stock: null` when inventory is down. Order history still loads when product-service is down.
- **Compensation instead of distributed transactions.** If inventory can't create the stock row, product-service deletes the product it just saved.
- **Choreography saga.** Placing an order is asynchronous. The order starts as `PENDING` and becomes `CONFIRMED` or `FAILED` through RabbitMQ events. No central coordinator.
- **Idempotent consumers.** A `ProcessedEvent` table records which messages were already handled, so a message delivered twice (RabbitMQ is at-least-once) is applied once. Messages are acknowledged only after the DB commit.
- **Transactional outbox.** order-service never publishes inside the request. It saves the `order.placed` event in an `OutboxEvent` table in the same transaction as the order, and a background relay publishes it. An order can't exist without its event, and RabbitMQ being down doesn't fail the order.
- **Retry with delay and a dead-letter queue.** A failing message is retried every 5s, up to 5 times, then parked in a `.dlq` queue with the error attached. It is never lost and never loops forever.
- **Correlation id.** One `x-request-id` follows a user action through the gateway, every service, every HTTP call and both RabbitMQ hops, so `docker compose logs | grep <id>` shows the whole story.
- **Edge auth.** The gateway verifies the JWT, strips any `x-user-*` headers the client sent, and sets them from the token. Services trust those headers, which is why they have no public port.

### Tech stack

| Layer | Choice |
|---|---|
| Services | Node.js 20, TypeScript, Express 5, Zod 4, Prisma 6 |
| Database | PostgreSQL 16 (one container, three databases) |
| Messaging | RabbitMQ 3 (topic exchange, `amqplib`) |
| Gateway | Express, `http-proxy-middleware`, `jsonwebtoken`, `express-rate-limit` |
| Client | React 18, Vite 6, react-router 6, axios, plain CSS |
| Runtime | Docker Compose: dev stage (live reload) and prod stage (compiled, non-root) of one multi-stage Dockerfile per app |
| Tests | Vitest (unit tests per package + an end-to-end suite) |

Version notes: Prisma 6, not 7 (7 needs driver adapters and `prisma.config.ts`). Express 5 because async errors reach the error handler without wrappers.

---

## Request flows

### F1: Create product (sync, product → inventory)

1. `POST /products` (admin JWT) → gateway → product-service.
2. product-service saves the product, then calls `POST http://inventory-service:4002/inventories {productId, quantity}`.
3. It stores the returned `inventoryId` on the product and returns the product with its stock.
4. **If inventory is down or errors:** product-service deletes the product (compensation) and returns **503**. You never get a product without a stock row.

### F2: Product details (sync read composition)

`GET /products/:id` → product-service calls `GET inventory/inventories/product/:productId` (2s timeout) → returns `{...product, stock}`.
If inventory is down, it returns the product with `stock: null`. A stopped container fails fast (DNS error); a paused one hits the 2s timeout.

The product **list** has no stock on purpose: one HTTP call per product would be an N+1 across the network.

### F3: Place order (async choreography saga)

```
client          gateway         order-service             RabbitMQ              inventory-service
  │ POST /orders   │                  │                        │                        │
  │───────────────▶│ verify JWT,      │                        │                        │
  │                │ set x-user-*  ──▶│ GET product snapshots  │                        │
  │                │                  │ (sync, product-service)│                        │
  │                │                  │ tx: Order PENDING      │                        │
  │                │                  │   + OutboxEvent row    │                        │
  │◀── 201 PENDING ────────────────────│                        │                        │
  │                                    │ relay: order.placed ──▶│── inventory.order-placed ─▶│
  │                                    │                        │                        │ one DB tx:
  │                                    │                        │                        │ reserve ALL items
  │ poll GET /orders/:id (1s)          │                        │                        │ or none
  │                                    │◀── order.inventory-result ── inventory.reserved / .failed
  │                                    │ PENDING → CONFIRMED / FAILED                    │
  │◀── CONFIRMED / FAILED ─────────────│                        │                        │
```

1. The client sends only `{items: [{productId, quantity}]}`. **Never a price.**
2. order-service fetches each product from product-service. Only `PUBLISHED` products can be ordered (draft or unknown → 400). Duplicate productIds are merged.
3. It computes totals with `Prisma.Decimal` (half-up, 2 dp): `subtotal`, `discount` (fixed at 0 for now), `tax = subtotal × TAX_RATE`, `grandTotal`. The order and its line items are saved in one nested create (same DB, so a real transaction). Status is `PENDING`.
4. In the **same transaction** it inserts the `order.placed` event into the `OutboxEvent` table, then answers **201 `PENDING`**. The outbox relay publishes the event right away (with publisher confirms) and marks the row as published. If RabbitMQ is down, the row waits and goes out when the broker is back; the order just stays `PENDING` longer.
5. inventory-service reserves stock for every item in one transaction. Rows are locked in `productId` order to avoid deadlocks. Each item uses a conditional `UPDATE ... WHERE available >= qty`. If any item is short, the whole transaction rolls back and the `inventory.failed` event lists every shortage.
6. order-service moves the order out of `PENDING` only. A late or duplicate event can't flip a final status.
7. The UI polls `GET /orders/:id` every second while the order is `PENDING`.

---

## Messaging (RabbitMQ)

| Exchange | Type | Routing key | Queue | Consumer |
|---|---|---|---|---|
| `ecommerce.events` | topic | `order.placed` | `inventory.order-placed` | inventory |
| `ecommerce.events` | topic | `inventory.*` | `order.inventory-result` | order |

Each consumed queue `Q` has two more queues next to it:

| Queue | Consumer | Purpose |
|---|---|---|
| `Q.retry` | none | Holds a failed message for 5s (`x-message-ttl`), then RabbitMQ dead-letters it back into `Q`. This is the retry delay. |
| `Q.dlq` | none (humans) | Messages that are malformed or failed 5 times. Headers say why: `x-last-error`, `x-attempt`, `x-original-routing-key`. |

```
         ┌─────────── handler OK ───────────▶ ack
  Q ──▶ consumer ── error, attempt < 5 ──▶ Q.retry ──(5s TTL)──▶ Q
         └── malformed, or 5th failure ──▶ Q.dlq
```

To replay DLQ messages after fixing the cause: in the RabbitMQ UI open **Queues → `Q.dlq` → Move messages** to `Q`. The shovel plugin that provides this is enabled in [infra/rabbitmq/enabled_plugins](infra/rabbitmq/enabled_plugins). **Get messages** with "Nack, requeue true" lets you look without removing anything.

### Event contracts

```jsonc
// order.placed  (order → inventory)
{ "eventId": "uuid", "orderId": "uuid", "items": [{ "productId": "uuid", "quantity": 2 }] }

// inventory.reserved  (inventory → order)
{ "eventId": "uuid", "orderId": "uuid", "occurredAt": "ISO-8601" }

// inventory.failed  (inventory → order)
{ "eventId": "uuid", "orderId": "uuid", "occurredAt": "ISO-8601",
  "reason": "Insufficient stock: <productId> (requested 5, available 1)",
  "shortages": [{ "productId": "uuid", "requested": 5, "available": 1 }] }
```

Every consumer validates incoming messages with Zod. Services share **contracts, not code**: the same `events/rabbit.ts` helper is copied into inventory and order, and there is no shared npm package.

### Delivery guarantees

| Concern | How it's handled |
|---|---|
| Message lost on broker restart | Durable exchange and queues, persistent messages |
| Publish not stored by broker | Confirm channel, `waitForConfirms()` before marking the outbox row published |
| Order saved but event never sent (or the reverse) | Transactional outbox: the order and its event commit together; the relay retries until published |
| RabbitMQ down when an order is placed | Order accepted as `PENDING`, event waits in `OutboxEvent`, goes out within ~1s of the broker returning |
| Event published before its consumer ever started | **Every** service declares the **whole** topology on connect, so the queue already exists |
| Consumer crashes mid-handler | Ack only after the DB commit; unacked → redelivered |
| Same message delivered twice (also: the outbox relay re-publishes after a crash) | `ProcessedEvent` row inserted in the same transaction as the change. Inventory also stores the result it sent and re-sends the same answer for a duplicate. |
| Malformed message | Straight to `Q.dlq` with the validation error in `x-last-error` |
| Handler error (DB down, deadlock) | To `Q.retry`, back in `Q` 5s later; after 5 attempts → `Q.dlq` |
| Retry or DLQ move fails (broker gone) | Copy first, ack after. If either fails the original stays unacked and is redelivered: duplicated at worst, never lost |
| RabbitMQ down at startup | Background connect loop with retry; HTTP keeps serving. `/health` shows `rabbit: up\|down` |
| Back-pressure | `prefetch(10)` per consumer |
| Tracing a message | AMQP `correlationId` = the original `x-request-id`; consumers log with it and pass it on |

---

## Data model

Full Prisma schemas: [product](services/product/prisma/schema.prisma), [inventory](services/inventory/prisma/schema.prisma), [order](services/order/prisma/schema.prisma).

**product_db**
- `Product`: `id`, `sku` (unique), `name`, `description?`, `price Decimal(10,2)`, `status` (`DRAFT | PUBLISHED | UNLISTED`), `inventoryId?` (string, no FK), timestamps.

**inventory_db**
- `Inventory`: `id`, `productId` (unique, string, no FK), `availableQuantity`, `reservedQuantity`, timestamps. This is the current balance.
- `StockHistory`: append-only ledger. `actionType` (`IN | OUT | RESERVE | RELEASE`), `quantityChanged`, `lastQuantity`, `currentQuantity`, `reason?`, `orderId?`.
- `ProcessedEvent`: `eventId` (PK), `resultKey`, `result` (JSON of the event sent back).

**order_db**
- `Order`: `id`, `userId`, `userName`, `userEmail` (copied from the gateway headers; no users table), `subtotal`, `discount`, `tax`, `grandTotal` (`Decimal(12,2)`), `status` (`PENDING | CONFIRMED | FAILED | CANCELLED`), `failureReason?`.
- `LineItem`: snapshot of the product at purchase time: `productId`, `productName`, `sku`, `price`, `quantity`, `total`.
- `ProcessedEvent`: `eventId` (PK).
- `OutboxEvent`: `id` (= the event's `eventId`), `routingKey`, `payload` (JSON), `correlationId?`, `publishedAt?` (null = not sent yet), `attempts`, `lastError?`. Published rows are deleted after 7 days.

Money is never a float. Prices travel as strings (`"19.99"`). Prisma prints Decimals without trailing zeros (`"18"`), so the UI formats them.

---

## API reference

All calls go through the gateway at `http://localhost:8081`. Send `Authorization: Bearer <token>` where auth is needed.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/register` | public | `{email, name, password (≥8)}` → 201 + same body as login. Role is always `user`. Taken email → 409. Limit 10/min. |
| POST | `/auth/login` | public | `{email, password}` → `{accessToken, tokenType, expiresIn, user}`. Limit 10/min. |
| GET | `/auth/me` | any token | The user, fresh from auth_db |
| GET | `/.well-known/jwks.json` | public | Public signing keys (what the gateway verifies with) |
| GET | `/users` | admin | All users (never the password hash) |
| PUT | `/users/:id/role` | admin | `{role: "user" \| "admin"}`. Effective on that user's next token. Not on yourself (400). |
| GET | `/health` | public | Gateway + every service. 200 if all up, 207 otherwise. |
| GET | `/products` | public | `?page=&limit=&status=`. No stock in the list. |
| GET | `/products/:id` | public | Includes `stock` (or `null` if inventory is down) |
| POST | `/products` | admin | `{sku, name, description?, price, status?=DRAFT, quantity?=0}` |
| PUT | `/products/:id` | admin | Any subset of `sku, name, description, price, status`. Stock is not editable here. |
| GET | `/inventories/product/:productId` | public | Stock for a product |
| GET | `/inventories/:id` | admin | |
| PUT | `/inventories/:id` | admin | `{actionType: "IN" \| "OUT", quantity, reason?}`. `OUT` below zero → 409. |
| GET | `/inventories/:id/history` | admin | `?limit=` (default 50, max 200) |
| POST | `/orders` | user, admin | `{items: [{productId, quantity}]}` (1–50 items, qty 1–1000) → 201 `PENDING` |
| GET | `/orders` | user, admin | `?page=&limit=&status=` → `{data, meta}`. Own orders only. |
| GET | `/orders/:id` | user, admin | Someone else's order → 404, not 403 |

Routes are defined in [api-gateway/src/config.json](api-gateway/src/config.json). Anything not listed there gets a 404 from the gateway. For example, `POST /inventories` is internal: only product-service calls it, directly over the Docker network.

Every response carries an `x-request-id` header (send your own to choose it). POST `/orders` returns 201 even when RabbitMQ is down; the order waits as `PENDING`.

Errors look like `{ "error": "ValidationError", "message": "..." }`. Common statuses: 400 validation, 401 no/bad token, 403 wrong role, 404 not found or not routed, 409 stock conflict, 429 rate limit, 503 a dependency is down.

Orders are scoped to `x-user-id` for every role, so an admin only sees their own orders too.

---

## API gateway internals

[api-gateway/src/index.ts](api-gateway/src/index.ts) runs each request through this pipeline:

1. **Request id.** Reuses or creates `x-request-id`, forwards it, and returns it in the response.
2. **Strip identity headers.** Deletes `x-user-id`, `x-user-email`, `x-user-name` and `x-user-role` from the incoming request, so a client can't send `x-user-role: admin`.
3. **CORS** for `http://localhost:5173`, plus morgan logging.
4. **Rate limit**: 300/min globally (`RATE_LIMIT_PER_MIN`), 10/min on login and register.
5. **Gateway endpoints**: only `/health`. Since Phase 9, login/register/me are ordinary routes to auth-service. The gateway never parses bodies, so they stream through untouched.
6. **Route table** from `config.json`. Each route has a method, path, service and roles. If the route has roles, the gateway verifies the JWT (RS256 pinned, plus issuer and audience) with the public keys from auth-service's JWKS, checks the role, sets the `x-user-*` headers from the claims and proxies the request. `x-user-name` is URL-encoded (header values must be ASCII). Keys are cached; an unknown `kid` triggers one refetch (at most every 5s), so key rotation needs no gateway restart. If the keys can't be loaded at all → 503, not 401.
7. **404** for everything else.

Login compares passwords in constant time and returns the same message for an unknown email and a wrong password.

---

## React client

[client/src](client/src) is Vite + React 18 + react-router 6 + axios with plain CSS.

| Path | Who | What |
|---|---|---|
| `/login` | everyone | Login form with quick-fill buttons for the demo users |
| `/` | everyone | Product list. Shoppers see `PUBLISHED` only; admin sees all. |
| `/products/:id` | everyone | Details with stock. Admin: adjust stock (IN/OUT) and see history. |
| `/products/new` | admin | Create a product with its initial stock |
| `/cart` | logged in | Cart in localStorage; checkout sends only `{productId, quantity}` |
| `/orders` | logged in | Own orders; polls every 2s while any order is `PENDING` |
| `/orders/:id` | logged in | Order detail; polls every 1s until a final status |

- The browser calls the gateway at `http://localhost:8081` (`VITE_API_URL`), not `http://api-gateway:8081`, which only resolves inside Docker.
- The session (JWT + user) is in localStorage under `ms.session`. A 401 on any call clears it and redirects to `/login`.
- Role checks in the UI only hide pages. The gateway enforces the roles.
- Quantity is **not** capped at the stock shown, so you can easily trigger the saga's `FAILED` path.

---

## Configuration

All settings are in `.env` (copied from [.env.example](.env.example)); Compose reads it automatically.

| Variable | Default | Used by |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `msstudy` | Compose |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | `postgres` / `postgres` | postgres, init.sql |
| `PRODUCT_DATABASE_URL`, `INVENTORY_DATABASE_URL`, `ORDER_DATABASE_URL`, `AUTH_DATABASE_URL` | per-service user @ `postgres:5432` | each service |
| `RABBITMQ_USER` / `RABBITMQ_PASSWORD` | `guest` / `guest` | rabbitmq |
| `RABBITMQ_URL` | `amqp://guest:guest@rabbitmq:5672` | inventory, order |
| `RABBITMQ_EXCHANGE` | `ecommerce.events` | inventory, order |
| `PRODUCT_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `ORDER_SERVICE_URL`, `AUTH_SERVICE_URL` | `http://<name>-service:<port>` | gateway, product, order |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `auth-service` / `shop` | auth (sets them), gateway (requires them) |
| `JWT_EXPIRES_IN` | `1h` | auth |
| `TAX_RATE` | `0.05` | order |
| `OUTBOX_POLL_MS` | `1000` | order (outbox relay poll interval; new orders also trigger it at once) |
| `RABBITMQ_MAX_ATTEMPTS` | `5` | inventory, order (attempts before a message goes to the DLQ) |
| `*_PORT` | see [Ports](#ports) | Compose |

Set directly in `docker-compose.yaml`: `INVENTORY_TIMEOUT_MS=2000` (product), `PRODUCT_TIMEOUT_MS=2000` (order), `CORS_ORIGIN` (gateway), `VITE_API_URL` (client; in the prod image it is a **build arg**, because Vite inlines it at build time). The 5s retry delay is a constant in `rabbit.ts`: it's a queue argument, and RabbitMQ refuses to re-declare a queue with different arguments. `AUTH_JWKS_URL` (gateway) is built from `AUTH_SERVICE_URL`. Optional in the gateway: `RATE_LIMIT_PER_MIN`.

### Ports

| Container | Host port |
|---|---|
| client | 5173 |
| api-gateway | 8081 |
| product-service | *(internal only: 4001)* |
| inventory-service | *(internal only: 4002)* |
| order-service | *(internal only: 4003)* |
| auth-service | *(internal only: 4004)* |
| postgres | 5432 |
| rabbitmq | 5672 (AMQP), 15672 (UI) |
| adminer | 8080 |

The services publish **no** host port. They trust the `x-user-*` headers the gateway adds, so they must only be reachable from inside the Docker network. Services call each other by container DNS name (`http://inventory-service:4002`), never through the gateway.

To call a service directly while debugging, use `docker compose exec`, for example:
`docker compose exec api-gateway node -e "fetch('http://inventory-service:4002/health').then(r=>r.text()).then(console.log)"`

---

## Failure scenarios to try

Each of these was verified while building (details in [PROGRESS.md](PROGRESS.md)).

| Do this | Expected |
|---|---|
| `docker compose stop inventory-service`, then open a product | Product loads with `stock: null` |
| Same, then create a product | 503, and no orphan product is left behind |
| `docker compose pause inventory-service`, then open a product | `stock: null` after the 2s timeout |
| `docker compose stop product-service`, then place an order | `POST /orders` → 503; `GET /orders` still 200 |
| Order more than is in stock | Order goes `PENDING` → `FAILED` with a shortage reason; nothing is reserved |
| Order 2 items where one is short | Whole order `FAILED`; the other item is **not** reserved either |
| `docker compose stop inventory-service`, place an order, then start it | Message waits in the queue; order goes `PENDING` → `CONFIRMED` after the restart |
| `docker compose stop rabbitmq`, place an order, then `start rabbitmq` | 201 `PENDING`; one unsent row in `OutboxEvent`; `CONFIRMED` a few seconds after RabbitMQ is back |
| Publish the same `order.placed` twice from the RabbitMQ UI | Stock is reserved once |
| Publish garbage to `inventory.order-placed` | Parked in `inventory.order-placed.dlq` with the error in `x-last-error`; the consumer keeps running |
| `docker compose stop postgres` ~12s while a message arrives, then start it | Logs show `attempt 1/5`, `2/5`… every 5s, then success |
| Keep Postgres stopped > 25s | 5th failure → message in the DLQ |
| `curl -H 'x-request-id: trace-1' ...` an order, then `docker compose logs \| grep trace-1` | Lines from the gateway, order, product and inventory, for HTTP and both RabbitMQ hops |
| 20 parallel orders of 1 on a stock of 12 | 12 `CONFIRMED`, 8 `FAILED`, stock 0 available / 12 reserved |
| Edit a product's price after ordering it | The old order keeps the old price (snapshot) |
| Send `x-user-role: admin` with a user token | Ignored: the gateway strips it |
| Log in as user, `PUT /inventories/:id` | 403 |

---

## Design decisions

The full dated log is in [PROGRESS.md](PROGRESS.md#decision-log). The main points:

- **Atomic stock changes.** Stock uses a conditional `updateMany WHERE availableQuantity >= qty` instead of read-check-write, so concurrent requests can't oversell.
- **RESERVE/RELEASE are saga-only.** The admin stock API accepts only `IN` and `OUT`.
- **Product service doesn't store stock.** It passes the initial `quantity` on to inventory.
- **Prices come from the server.** The client never sends a price, so nobody can buy a $500 item for $1.
- **Not found instead of forbidden.** Another user's order returns 404, which doesn't reveal that it exists.
- **No `depends_on` between services.** Product and order start and serve what they can when their dependencies are down. They depend only on a healthy Postgres.
- **Graceful shutdown.** Compose `init: true` plus `exec` in the Dockerfile CMD, so SIGTERM reaches Node and the servers close cleanly.
- **The route table is explicit** (method + path + roles), not prefix-based, so internal endpoints are never exposed by accident.
- **Outbox only in order-service.** Inventory already stores its answer in `ProcessedEvent` before publishing, and the triggering `order.placed` stays unacked until the publish succeeds, so a redelivery re-sends the same answer.
- **Retry queues instead of `nack(requeue)`.** A requeued message comes straight back with no delay and no attempt count. The `.retry` queue gives both, without a plugin.
- **Main queues have no arguments.** The retry and DLQ wiring sits on the new queues, so existing queues didn't need to be deleted and re-created.
- **The seed goes through the API, not SQL.** Creating a product spans two databases and product-service owns that logic.
- **Tests live in `test/`, outside `src/`.** TypeScript builds and prod images never include them.

---

## Gotchas and lessons learned

- **Zod 4 `.partial()` keeps `.default()`s.** An update schema built from the create schema silently reset `status` to `DRAFT` on every partial update. Fix: build both from a base schema with no defaults.
- **Declare the whole topology everywhere.** If only the consumer declares its queue, an event published before that consumer first starts matches no queue and is silently dropped.
- **RabbitMQ management stats lag about 5 seconds.** Don't panic if queue counts look stale.
- **`init.sql` runs only on an empty volume.** After editing it, run `docker compose down -v`.
- **Upgrading an existing (pre-Phase 9) volume:** auth_db doesn't exist yet. Create it once without losing data: `docker compose exec -T postgres psql -U postgres < infra/postgres/02-auth.sql`, then `docker compose up -d --build -V`.
- **`node_modules` in a bind mount.** An anonymous volume (`/app/node_modules`) keeps the container's Linux modules separate from the host's.
- **DNS inside compose containers.** `yarn add` inside a compose container failed with `EAI_AGAIN`. Workaround: run it in a throwaway container on the host network (see [Development workflow](#development-workflow)).
- **Migration files are owned by root** because the container runs as root. Run `sudo chown -R $USER services/<svc>/prisma` after creating one.
- **Vite file watching on a bind mount** needs polling (already set in [client/vite.config.ts](client/vite.config.ts)).
- **Alpine resolves `localhost` to `::1` (IPv6).** nginx listened on IPv4 only, so the client's health check failed until `listen [::]:80` was added.
- **Vite inlines `VITE_*` at build time.** In the prod image the gateway URL is a Docker build arg; changing it means rebuilding.
- **The prod container runs `prisma migrate deploy`**, so `prisma` is a runtime dependency, not a dev one.
- **Re-declaring a queue with different arguments fails** (`PRECONDITION_FAILED`). That's why the retry delay is a constant, and why retry/DLQ wiring went on new queues.
- **After a retry, `routingKey` is the queue name.** The message comes back through the default exchange, so the original key travels in the `x-original-routing-key` header.
- **zsh doesn't word-split `$VARS`.** `docker compose $FILES up` fails in zsh; use `COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml` instead.
- **The course diagram's "place order → Catalog Service" is a typo.** It means the Order service.

---

## Known gaps

These are deliberate for now.

- **Reserved stock is never released or shipped.** There is no cancel or fulfilment step yet, so `reservedQuantity` only grows. `RELEASE` and `CANCELLED` exist in the schema but are unused.
- **Private signing keys live in auth_db** (`SigningKey` table). A real system keeps them in a KMS or secret store.
- **No refresh tokens or logout-everywhere.** An access token is valid until it expires (1h); a role change applies on the next login.
- **A key removed from the JWKS stays trusted until the gateway restarts** (keys are cached forever; only unknown `kid`s trigger a refetch).
- **The `Authorization` header is still forwarded** to the services. It's harmless, but could be stripped.
- **No alerting on the DLQ.** Messages there wait for someone to look at the RabbitMQ UI.
- **Each e2e run leaves one garbage message** in `inventory.order-placed.dlq`; that's what the DLQ test checks. Purge it from the UI when you like.
- **Unit tests cover pure logic only** (pricing, schemas, auth, route table). Handlers that touch the DB are covered by the e2e suite, not by isolated tests.
- **No Cart or Email services, and no Kong/Keycloak yet** (Phases 10–13 in [PLAN.md](PLAN.md)).

---

## Tests

```bash
# unit tests (Vitest), inside the running dev containers
docker compose exec order-service yarn test       # pricing (Decimal, half-up tax), order + event schemas
docker compose exec product-service yarn test     # price validation, the .partial() defaults regression
docker compose exec inventory-service yarn test   # admin can't RESERVE, event contract
docker compose exec api-gateway yarn test         # RS256 via JWKS (foreign key, iss/aud, alg none, expiry), roles, 503, route table
docker compose exec auth-service yarn test        # scrypt hashing, register/login schemas, token signing

# end-to-end: the whole stack through the gateway (works against the dev or the prod stack)
docker compose --profile test run --rm e2e
```

The e2e suite ([tests/e2e/saga.test.ts](tests/e2e/saga.test.ts)) runs in a container on the compose network and creates its own products on every run. It checks:

- health and the echoed correlation id;
- 401/403, forged headers and unrouted internal endpoints;
- product creation including its stock;
- `CONFIRMED` / `FAILED` / all-or-nothing outcomes;
- the reservation showing in the stock history;
- draft products are rejected, and line items are a snapshot;
- another user's order returns 404;
- 10 parallel orders on a stock of 6 give exactly 6 `CONFIRMED`;
- a malformed message lands in the DLQ.

---

## Development workflow

```bash
docker compose logs -f <service>        # follow one service's logs
docker compose stop inventory-service   # simulate an outage
docker compose down                     # stop, keep the data
docker compose down -v                  # stop and DELETE all data (init.sql runs again on the next up)

# code changes reload live (bind mounts). After changing a package.json:
# rebuild AND renew the anonymous node_modules volume
docker compose up -d --build -V inventory-service

# after changing a schema.prisma: create a migration (the file lands on your disk)
docker compose run --rm inventory-service yarn prisma migrate dev --name <what_changed>
sudo chown -R $USER services/inventory/prisma   # the container wrote it as root
```

Each service runs `prisma migrate deploy` on start, so new migrations apply automatically.

```bash
# trace one request through every service
docker compose logs --no-log-prefix | grep <x-request-id>

# add a package: `yarn add` inside a compose container fails on DNS here, so run it on the host network
docker run --rm --network host -u $(id -u):$(id -g) -e HOME=/tmp -v "$PWD/services/order:/app" -w /app node:20-slim yarn add <pkg>
docker compose up -d --build -V order-service
```

Each service follows the same layout: `index.ts` (Express app, `/health`, shutdown), `context.ts` (correlation id + logger), `routes.ts`, `controllers/`, `schemas.ts` (Zod), `errors.ts`, `prisma.ts`, `clients/` (HTTP to other services) and `events/` (RabbitMQ, outbox) where needed, and `test/` (Vitest).

Working agreement: the system is built **one phase at a time**. At the end of each phase, update [PROGRESS.md](PROGRESS.md) (status, what was verified, decisions).

---

## Project layout

```
micro-service-study/
├── docker-compose.yaml          # dev stack (+ seed job, + e2e under the "test" profile)
├── docker-compose.prod.yaml     # override: prod Dockerfile stages, no bind mounts, nginx client
├── .env.example                 # copy to .env
├── infra/
│   ├── postgres/init.sql        # creates the 3 DBs, their users, and revokes cross-access
│   ├── postgres/02-auth.sql     # auth_db + auth_svc (idempotent: also runnable on an existing volume)
│   ├── rabbitmq/enabled_plugins # management + shovel ("Move messages" out of a DLQ)
│   └── seed/seed.mjs            # demo products through the gateway (idempotent)
├── api-gateway/
│   └── src/  index.ts · auth.ts (JWKS verify, roles) · utils.ts (proxy) · config.json (route table)
├── services/
│   ├── product/                 # clients/inventory.ts → sync HTTP to inventory
│   ├── inventory/               # events/order-placed.ts → reserve stock; events/rabbit.ts (retry/DLQ)
│   ├── order/                   # pricing.ts, events/outbox.ts, events/inventory-result.ts, clients/product.ts
│   └── auth/                    # passwords.ts (scrypt), keys.ts (RS256 + JWKS), tokens.ts, scripts/rotate-key.ts
├── client/                      # React + Vite
│   ├── src/  pages/ · components/ · api.ts · auth.tsx · cart.tsx
│   └── nginx.conf               # prod: SPA fallback + /healthz
├── tests/e2e/                   # end-to-end saga suite (Vitest)
├── docs/sokrio-takeaways.md     # which of these patterns apply to Sokrio
├── PLAN.md                      # design and phase plan
├── PROGRESS.md                  # live status + decision log
├── mircro-service-er-digram.pdf # course ER diagram
└── *_PracticalMicroservices_*.pdf  # course material
```

---

## Roadmap

| Phase | What | Status |
|---|---|---|
| 0 | Infrastructure: Postgres, RabbitMQ, Adminer | ✅ |
| 1 | Inventory service | ✅ |
| 2 | Product service + sync call to inventory | ✅ |
| 3 | API gateway + JWT | ✅ |
| 4 | Order service (sync part) | ✅ |
| 5 | RabbitMQ saga (order ↔ inventory) | ✅ |
| 6 | React client | ✅ |
| 7 | Docker polish: health checks, multi-stage prod images, seed data, one-command start from zero | ✅ |
| 8 | Stretch: retry + DLQ, transactional outbox, correlation-id logging, Vitest + end-to-end saga test, Sokrio takeaways | ✅ |
| 9 | Auth/User service: register/login, scrypt, RS256 tokens + JWKS, key rotation | ✅ |
| 10–13 | Optional: Email (Mailpit), Cart (Redis), Keycloak, Kong — see [PLAN.md](PLAN.md) §7b | not started |
