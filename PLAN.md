# Practical Microservices — Study Build Plan

> Source material: `8ffc…PracticalMicroservices….pdf` (Stack Learner course) + `mircro-service-er-digram.pdf`.
> Goal: learn microservices by building a small e-commerce system end to end, everything running in Docker.
> Started: 2026-11-10 · Working mode: phase by phase. Claude writes and explains each phase, you run and verify it, then say **"continue"**.

---

## 1. Decisions (locked)

| Topic | Decision | Why |
|---|---|---|
| Services | **Product**, **Inventory**, **Order** | Matches the course screenshot. Covers both sync REST and async events |
| Gateway | **Custom Express gateway** (`config.json` route map + proxy) | You learn what a gateway really does. Kong is an optional later phase |
| Auth | **Simple JWT, checked in the gateway** | Small. Services trust the `x-user-id` header the gateway adds |
| UI | **React + Vite + TypeScript** | |
| DB | **PostgreSQL + Prisma**, **one database per service** | Core microservice rule: no shared tables, no cross-service foreign keys |
| Messaging | **RabbitMQ** (topic exchange) | Order ↔ Inventory talk through events |
| Language | **Node.js + TypeScript + Express**, package manager **yarn** | Same as course screenshot |
| Runtime | **Docker Compose** for everything (infra + services + UI) | One command: `docker compose up` |

**Out of scope at the start** (stretch, see Phase 8 and §7b): Auth/User service (done in Phase 9), Cart with 10-min TTL (Redis), Email service, Keycloak, Kong.

---

## 2. Architecture

```
                 ┌──────────────┐
  Browser ─────▶ │ client (React)│  :5173
                 └──────┬───────┘
                        │ HTTP (all calls go through gateway)
                 ┌──────▼───────┐
                 │ api-gateway  │  :8081   JWT check, routing, x-user-id header
                 └──┬────┬────┬─┘
        /products   │    │    │  /orders
          ┌─────────▼┐ ┌─▼──────────┐ ┌▼─────────┐
          │ product  │ │ inventory  │ │  order   │
          │  :4001   │ │   :4002    │ │  :4003   │
          └──┬───┬───┘ └──┬────▲────┘ └─┬──▲──┬──┘
   sync HTTP │   └────────┘    │        │  │  │ sync HTTP (product snapshot)
             │                 │        │  │  └──────────▶ product
             ▼                 ▼        ▼  │
       product_db        inventory_db  order_db
                               │           │
                               └──▶ RabbitMQ ◀──┘   exchange: ecommerce.events (topic)
```

Every service owns its own DB. All databases live in **one Postgres container**, created by an init script. In production you would usually use separate instances, but one container is enough for study.

### Ports

| Container | Port | Notes |
|---|---|---|
| client | 5173 | Vite dev server |
| api-gateway | 8081 | only public entry point for the UI |
| product-service | 4001 | |
| inventory-service | 4002 | |
| order-service | 4003 | |
| auth-service | 4004 | Phase 9, DB `auth_db` |
| postgres | 5432 | DBs: `product_db`, `inventory_db`, `order_db` |
| rabbitmq | 5672 / 15672 | 15672 = management UI (guest/guest) |
| adminer (optional) | 8080 | browse Postgres |

---

## 3. Data model (per service, from the "Full ER Diagram")

**product_db / Product**
`id (uuid) · sku (unique) · name · description · price (Decimal) · status (DRAFT|PUBLISHED|UNLISTED) · inventoryId (nullable, plain string — NOT a FK) · createdAt · updatedAt`

**inventory_db / Inventory**
`id · productId (unique, plain string) · availableQuantity · reservedQuantity · createdAt · updatedAt`

**inventory_db / StockHistory**
`id · inventoryId (FK, same DB) · actionType (IN|OUT|RESERVE|RELEASE) · quantityChanged · lastQuantity · currentQuantity · reason/orderId · createdAt`

**order_db / Order**
`id · userId · userName · userEmail · subtotal · discount · tax · grandTotal · status (PENDING|CONFIRMED|FAILED|CANCELLED) · failureReason · createdAt · updatedAt`

**order_db / LineItem**
`id · orderId (FK, same DB) · productId · productName · sku · price · quantity · total`
→ product name/sku/price are **copied** into the order. If a product is later edited or deleted, the order history stays correct. This is the main lesson from the course's "Problem with our design" slide.

**order_db / ProcessedEvent** (Phase 5)
`eventId (PK) · processedAt` → stops the same RabbitMQ message from being handled twice (idempotency).

---

## 4. Communication flows

### F1 — Create product (sync, Product → Inventory)
1. `POST /products` (admin JWT) → gateway → product-service
2. product-service saves the product, then calls `POST inventory:4002/inventories {productId, quantity}`
3. Saves the returned `inventoryId` on the product and returns the product with its stock

### F2 — Product details (sync read composition)
`GET /products/:id` → product-service fetches `GET inventory/inventories/product/:productId` → returns `{...product, stock}`.
If inventory is down, it returns the product with `stock: null`. **Lesson: partial failure.**

### F3 — Place order (async saga / choreography)
1. `POST /orders {items:[{productId, quantity}]}` (user JWT) → gateway adds `x-user-id`, `x-user-email`
2. order-service fetches product snapshots (sync, from product-service), calculates totals, saves the order as **PENDING**
3. order-service publishes **`order.placed`** `{eventId, orderId, items}`
4. inventory-service consumes it and, in one DB transaction, checks stock for all items:
   - enough stock → decrements stock, writes StockHistory, publishes **`inventory.reserved`**
   - not enough → changes nothing, publishes **`inventory.failed`** `{reason}`
5. order-service consumes the result → order becomes **CONFIRMED** or **FAILED**
6. UI polls `GET /orders/:id` and shows the final status

### RabbitMQ topology
| Exchange | Type | Routing key | Queue | Consumer |
|---|---|---|---|---|
| `ecommerce.events` | topic | `order.placed` | `inventory.order-placed` | inventory |
| `ecommerce.events` | topic | `inventory.*` | `order.inventory-result` | order |

Queues are durable, messages persistent, ack sent manually after the DB commit. Phase 8 adds a DLQ.

---

## 5. API (through the gateway at :8081)

| Method | Path | Auth | Service |
|---|---|---|---|
| POST | `/auth/login` | public | gateway (demo users from env) |
| GET | `/products` | public | product |
| GET | `/products/:id` | public | product (+ inventory) |
| POST | `/products` | admin | product (+ inventory) |
| PUT | `/products/:id` | admin | product |
| GET | `/inventories/product/:productId` | public | inventory |
| PUT | `/inventories/:id` | admin | inventory (stock in/out + history) |
| GET | `/inventories/:id/history` | admin | inventory |
| POST | `/orders` | user | order |
| GET | `/orders` | user | order (own orders only) |
| GET | `/orders/:id` | user | order |

Gateway `config.json` maps each path prefix to an upstream URL, the allowed methods and the required role. Service-to-service calls go **directly** (container DNS, e.g. `http://inventory-service:4002`) and never through the gateway.

---

## 6. Folder layout (target)

```
micro-service-study/
├── PLAN.md  PROGRESS.md
├── docker-compose.yaml
├── .env.example
├── infra/postgres/init.sql            ← creates product_db, inventory_db, order_db
├── api-gateway/
│   ├── src/{index.ts, config.json, utils.ts, auth.ts}
│   ├── Dockerfile  package.json  tsconfig.json  .env
├── services/
│   ├── product/    src/{index.ts, controllers/, schemas.ts, prisma.ts, clients/inventory.ts}  prisma/schema.prisma  Dockerfile
│   ├── inventory/  src/{..., events/consumer.ts, events/publisher.ts}                         prisma/schema.prisma  Dockerfile
│   └── order/      src/{..., events/, clients/product.ts}                                     prisma/schema.prisma  Dockerfile
└── client/         Vite React app, Dockerfile
```

Common libraries in each service: `express`, `zod` (request validation), `@prisma/client` + `prisma`, `axios`, `dotenv`, `morgan`, `amqplib` (inventory and order), `tsx` (dev watch).
Gateway: `express`, `http-proxy-middleware`, `jsonwebtoken`, `cors`, `express-rate-limit`.

---

## 7. Phases

Each phase ends with a **checkpoint**: commands you run and the result you should see. Stop and say "continue".

### Phase 0 — Workspace + infra
- `git init`, `.gitignore`, root `docker-compose.yaml` with **postgres** (+ `init.sql`), **rabbitmq:3-management**, **adminer**
- `.env.example` with all ports, DB URLs and the JWT secret
- **Checkpoint:** `docker compose up -d` → Adminer shows 3 empty DBs; RabbitMQ UI opens at :15672
- **Learn:** database-per-service, Docker networks and service DNS names, volumes

### Phase 1 — Inventory service
- Express + TS skeleton, `/health`, Prisma schema (Inventory, StockHistory), migration
- `POST /inventories`, `GET /inventories/:id`, `GET /inventories/product/:productId`, `PUT /inventories/:id` (IN/OUT, writes history in a transaction), `GET /inventories/:id/history`
- Zod validation, central error handler
- Dockerfile (dev: `tsx watch` + bind mount; runs `prisma migrate deploy` on start), added to compose
- **Checkpoint:** curl creates inventory, stock change → history rows appear
- **Learn:** Prisma migrations, transactions, why history is kept as a separate table

### Phase 2 — Product service + sync call
- Prisma schema (Product), CRUD, `clients/inventory.ts` (axios with a timeout)
- F1 create product → creates inventory; F2 details → merges stock in, handles inventory being down
- **Checkpoint:** create a product → inventory row exists in `inventory_db`; `docker compose stop inventory-service` → `GET /products/:id` still works with `stock: null`
- **Learn:** sync coupling, timeouts, partial failure, no cross-DB foreign keys

### Phase 3 — API gateway + JWT
- `config.json` route table → proxy middleware is generated from it (`utils.ts`)
- `POST /auth/login` (2 demo users: `admin`, `user`) → signs a JWT
- Middleware: verify JWT, check role, add `x-user-id` / `x-user-email` / `x-user-role` headers; CORS; rate limit; request-id header
- Services stop publishing their ports to the host (only the gateway is public)
- **Checkpoint:** `POST /products` without a token → 401, with a user token → 403, with an admin token → 201
- **Learn:** single entry point, edge auth, trusting headers inside the network

### Phase 4 — Order service (sync part)
- Prisma schema (Order, LineItem), `clients/product.ts`
- `POST /orders`: fetch product snapshots → calculate subtotal/tax/grandTotal → save as PENDING
- `GET /orders`, `GET /orders/:id` (scoped to `x-user-id`)
- **Checkpoint:** place an order → PENDING order with copied product data; edit the product price → the old order is unchanged
- **Learn:** snapshot data, why orders don't join the products table

### Phase 5 — RabbitMQ saga
- Shared `rabbit.ts` helper (connect with retry, assert exchange and queues, publish/consume as JSON)
- order publishes `order.placed`; inventory consumes it → reserves stock in a transaction → publishes `inventory.reserved|failed`; order consumes it → CONFIRMED/FAILED
- Idempotency through `ProcessedEvent`; manual ack only after the DB commit
- **Checkpoint:** a normal order → CONFIRMED and stock drops, with history rows; an order larger than stock → FAILED and stock unchanged; stop inventory, place an order (stays PENDING), start inventory → order becomes CONFIRMED (the message waited in the queue)
- **Learn:** eventual consistency, choreography saga, at-least-once delivery, idempotent consumers

### Phase 6 — React client
- Vite + React + TS, axios instance → gateway, token kept in localStorage
- Pages: Login · Product list · Product detail (stock) · Admin: create product / adjust stock · Place order · My orders (status polling)
- Dockerfile + compose service
- **Checkpoint:** the full user journey in the browser; order status changes from PENDING to CONFIRMED live
- **Learn:** the UI only knows the gateway, and handles async status

### Phase 7 — Full Docker polish
- Healthchecks + `depends_on: condition: service_healthy`, restart policies
- Multi-stage production Dockerfiles (`docker-compose.prod.yaml`): build TS → slim runtime image
- Seed script (sample products + stock); README with a one-command start
- **Checkpoint:** `docker compose down -v && docker compose up --build` → whole system works from zero
- **Learn:** startup ordering, dev vs prod images, reproducibility

### Phase 8 — Stretch (pick any, later)
- Dead-letter queue + retry with delay
- Transactional **outbox** pattern (an order and its event are saved atomically)
- Correlation-id logging across services
- Tests: Vitest unit tests + one end-to-end saga test
- Add the course's other services: **Auth/User**, **Cart** (Redis 10-min hold), **Email** (consumes `order.confirmed`)
- Swap the custom gateway for **Kong**; auth with **Keycloak**
- **Sokrio takeaways:** a note on which patterns apply to Sokrio (snapshot line items, stock history, async jobs over RabbitMQ)

---

## 7b. Phase 9+ — extra services (approved 2026-11-11)

Recommended order: **9 Auth → 10 Email → 11 Cart → 12 Keycloak → 13 Kong**.
Why this order: Auth first because it changes how tokens are verified (JWKS), which makes Keycloak a small swap later. Email is small and reuses the outbox. Kong is last because it replaces the gateway everything else is tested against.

### Phase 9 — Auth/User service (`auth-service` :4004, `auth_db`)
- Prisma `User` (id, email unique, name, passwordHash, role, createdAt). Passwords hashed with `node:crypto` **scrypt** (no native build deps).
- Endpoints: `POST /auth/register` (role always `user`), `POST /auth/login`, `GET /auth/me`, `GET /users` (admin).
- Tokens move from **HS256 shared secret → RS256**: only auth-service holds the private key; it publishes `GET /.well-known/jwks.json`. The gateway fetches and caches the public key (`jose` `createRemoteJWKSet`) and verifies locally. `kid` in the header → key rotation possible.
- Gateway: `/auth/*` becomes proxied routes in `config.json`; `JWT_SECRET` and the demo-user list are removed. Login rate limit stays in the gateway.
- Migration seeds the 2 demo users with the **same UUIDs** as today, so existing orders still belong to them.
- Client: Register page.
- **Checkpoint:** register → login → order CONFIRMED; a token signed with any other key → 401; `stop auth-service` → existing tokens still work (cached JWKS), login → 502 from the proxy; gateway restarted while auth is down → 503 (not 401); duplicate email → 409; rotate key → new tokens work without a gateway restart.
- **Learn:** identity as its own service, asymmetric signing, why the gateway must not be able to mint tokens.

### Phase 10 — Email service (`email-service` :4006, `email_db`, **Mailpit** :8025)
- order-service publishes `order.confirmed` / `order.failed` through the **outbox**, in the same transaction as the status change (payload: orderId, userEmail, userName, totals, line items).
- email-service consumes them (queue `email.order-events`, retry + DLQ like the others), renders a plain HTML email, sends via SMTP (nodemailer) to Mailpit. `SentEmail` table (eventId unique) = idempotency.
- **Checkpoint:** order → email visible in Mailpit UI; same event sent twice → one email; Mailpit stopped → retries, then email arrives when it's back (or DLQ after 5).
- **Learn:** a downstream consumer added without touching inventory; events as the integration point.

### Phase 11 — Cart service (`cart-service` :4005, **Redis**)
- Cart per user in Redis hash `cart:{userId}` → `{productId: qty}`, **TTL 10 min, reset on every change** (`CART_TTL_SECONDS`). Redis with AOF on, so a restart doesn't empty carts.
- Endpoints: `GET /cart` (with product names/prices from product-service, one batched call), `PUT /cart/items/:productId`, `DELETE /cart/items/:productId`, `DELETE /cart`, `POST /cart/checkout` → calls order-service `POST /orders` (forwarding identity + request id), clears the cart only on 201.
- **No stock hold** in inventory: the cart is only a list; the saga still decides at checkout. (A real hold = inventory HOLD rows + release on expiry; noted as an option, not built.)
- Client: cart moves from localStorage to the server.
- **Checkpoint:** cart survives page reload and other browsers; with TTL 30s the cart is gone after 30s idle; checkout → order CONFIRMED, cart empty; order-service down → checkout 503, cart kept.
- **Learn:** ephemeral state in Redis, TTLs, service-to-service orchestration (checkout).

### Phase 12 — Keycloak (replaces auth-service as the token issuer)
- Keycloak container (`start-dev`, own Postgres DB) with a realm import: realm `shop`, public client `shop-client` (PKCE), realm roles `user` / `admin`, the 2 demo users.
- Gateway verifies Keycloak tokens via its JWKS URL (same code as Phase 9, new issuer/audience) and maps `sub`, `email`, `name`, `realm_access.roles` → `x-user-*` headers.
- Client logs in with redirect + PKCE (`oidc-client-ts`).
- auth-service stays in the repo behind an env switch (`AUTH_ISSUER=local|keycloak`) for comparison.
- **Checkpoint:** login via Keycloak page → order works; role change in Keycloak admin → effective on next token.
- **Learn:** OIDC, delegating identity to a standard IdP vs building your own.

### Phase 13 — Kong (alternative gateway, compose override `docker-compose.kong.yaml`)
- Kong OSS DB-less, declarative `kong.yml`: same routes as `config.json`, plugins `cors`, `rate-limiting`, `correlation-id`, `jwt` (Keycloak RS256 public key).
- Identity headers: strip client `x-user-*`, then a small `pre-function` (Lua) copies verified claims into `x-user-*` (Kong OSS has no OIDC plugin).
- Runs on the same port 8081, so client and e2e suite run unchanged against it.
- **Checkpoint:** e2e suite passes against Kong; forged `x-user-role` still ignored.
- **Learn:** off-the-shelf gateway config vs our hand-written one; what we had to rebuild by hand.

---

## 8. Risks / gotchas to watch

- **Prisma in Alpine images** needs `openssl`; set `binaryTargets` or use `node:20-slim`.
- **RabbitMQ starts slowly.** Services must retry the connection, not crash. A compose healthcheck helps.
- **`node_modules` inside a bind mount**: use an anonymous volume (`/app/node_modules`) so host and container modules don't clash.
- **Migrations**: each service runs `prisma migrate deploy` on start. Create new migrations with `prisma migrate dev` from inside the container.
- **Decimal money**: use Prisma `Decimal` and never JS float math for totals.
- Remember that the diagram PDF's "place order → Catalog Service" is a typo: it's the **Order** service.
