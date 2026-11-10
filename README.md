# Micro-Service Study — E-commerce on Docker

A small e-commerce system built to learn microservices hands-on: three Node.js services (Product, Inventory, Order) behind a custom API gateway, each service with its own Postgres database, talking over HTTP and RabbitMQ, with a React client. Everything runs in Docker Compose.

Based on the Stack Learner *Practical Microservices* course. The full design is in [PLAN.md](PLAN.md), and the current build status is in [PROGRESS.md](PROGRESS.md).

> **Status:** Phases 0–3 (infrastructure, Inventory and Product services, API gateway) are done. The services are being built one phase at a time. See [Roadmap](#roadmap).

---

## Architecture

```
  Browser ──▶ client (React, :5173)
                 │  every call goes through the gateway
                 ▼
            api-gateway (:8081)   JWT check · routing · adds x-user-* headers
             │        │        │
             ▼        ▼        ▼
         product   inventory   order
          :4001     :4002      :4003
             │  HTTP ─┘  ▲        │  HTTP (product snapshot)
             │           │        └──────────▶ product
             ▼           ▼        ▼
        product_db  inventory_db  order_db       (one Postgres, 3 isolated DBs)
                         │        │
                         └─▶ RabbitMQ ◀─┘        exchange: ecommerce.events (topic)
```

| Service | Owns | Talks to |
|---|---|---|
| **product** | `Product` | inventory (sync HTTP: creates stock, reads stock) |
| **inventory** | `Inventory`, `StockHistory` | consumes `order.placed`, publishes `inventory.reserved` / `inventory.failed` |
| **order** | `Order`, `LineItem`, `ProcessedEvent` | product (sync HTTP for the snapshot), publishes `order.placed`, consumes `inventory.*` |
| **api-gateway** | none | the only entry point for the UI; it signs and checks JWTs |

### Key ideas this project demonstrates
- **One database per service**: each service has its own database *and* its own Postgres user, so a service can't connect to another service's database.
- **Snapshot data**: an order line item copies the product's name, SKU and price, so the order history stays correct after a product changes.
- **Partial failure**: product details still load with `stock: null` when inventory is down.
- **Choreography saga**: placing an order is asynchronous. The order starts as `PENDING` and becomes `CONFIRMED` or `FAILED` through RabbitMQ events.
- **Idempotent consumers**: a `ProcessedEvent` table records which messages were already handled, so a message delivered twice (at-least-once delivery) is applied once. Messages are acknowledged only after the DB commit.
- **Edge auth**: the gateway verifies the JWT, and the services trust the `x-user-id` header the gateway adds.

---

## Tech stack

| Layer | Choice |
|---|---|
| Services | Node.js 20 + TypeScript + Express, Zod, Prisma |
| Database | PostgreSQL 16 (one container, three databases) |
| Messaging | RabbitMQ 3 (topic exchange) |
| Gateway | Express + `http-proxy-middleware` + `jsonwebtoken` |
| Client | React + Vite + TypeScript |
| Runtime | Docker Compose |

You only need Docker installed on your machine. Node and yarn run inside the containers.

---

## Quick start

```bash
cp .env.example .env        # first time only
docker compose up -d        # start everything
docker compose ps           # wait until postgres and rabbitmq show "healthy"
```

| What | URL | Login |
|---|---|---|
| Adminer (browse Postgres) | http://localhost:8080 | system `PostgreSQL`, server `postgres`, see the DB users below |
| RabbitMQ management | http://localhost:15672 | `guest` / `guest` |
| API gateway | http://localhost:8081/health | see [Demo users](#demo-users) |
| React client *(Phase 6+)* | http://localhost:5173 | |

### Demo users

| Email | Password | Role |
|---|---|---|
| `admin@shop.test` | `admin123` | admin: create/edit products, adjust stock, see history |
| `user@shop.test` | `user123` | user: place and view own orders |

```bash
TOKEN=$(curl -s -XPOST localhost:8081/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@shop.test","password":"admin123"}' | jq -r .accessToken)
curl -XPOST localhost:8081/products -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"sku":"MUG-01","name":"Mug","price":"8.00","status":"PUBLISHED","quantity":5}'
```

### Database users

| Database | User | Password |
|---|---|---|
| `product_db` | `product_svc` | `product_pw` |
| `inventory_db` | `inventory_svc` | `inventory_pw` |
| `order_db` | `order_svc` | `order_pw` |
| *(superuser)* | `postgres` | `postgres` |

These are development-only credentials.

### Useful commands

```bash
docker compose logs -f <service>     # follow the logs of one service
docker compose stop inventory-service   # simulate an outage (Phase 2+)
docker compose down                  # stop, keep the data
docker compose down -v               # stop and DELETE all data (init.sql runs again on the next up)

# after changing a service's package.json: rebuild AND renew the node_modules volume
docker compose up -d --build -V inventory-service

# after changing a schema.prisma: create a migration (the file lands on your disk)
docker compose run --rm inventory-service yarn prisma migrate dev --name <what_changed>
```

> `infra/postgres/init.sql` runs **only** when the Postgres volume is empty. After you edit it, run `docker compose down -v` before the change takes effect.

---

## Ports

| Container | Host port |
|---|---|
| client | 5173 |
| api-gateway | 8081 |
| product-service | *(internal only: 4001)* |
| inventory-service | *(internal only: 4002)* |
| order-service | *(internal only: 4003)* |
| postgres | 5432 |
| rabbitmq | 5672 (AMQP), 15672 (UI) |
| adminer | 8080 |

All ports are set in `.env`. The services publish **no** host port: they trust the `x-user-*` headers the gateway adds, so they must only be reachable from inside the Docker network. Only the gateway and the client are public. Services call each other through container DNS names (`http://inventory-service:4002`), never through the gateway.

---

## API (through the gateway)

| Method | Path | Auth |
|---|---|---|
| POST | `/auth/login` | public |
| GET | `/auth/me` | any token |
| GET | `/health` | public (gateway + every service) |
| GET | `/products`, `/products/:id` | public |
| POST / PUT | `/products`, `/products/:id` | admin |
| GET | `/inventories/product/:productId` | public |
| PUT | `/inventories/:id` | admin |
| GET | `/inventories/:id/history` | admin |
| POST / GET | `/orders`, `/orders/:id` | user (own orders only) |

Routes are defined in [api-gateway/src/config.json](api-gateway/src/config.json). Anything not listed there gets a 404 from the gateway (for example `POST /inventories`, which only product-service may call, directly). The full request flows are in [PLAN.md §4](PLAN.md).

---

## Project layout

```
micro-service-study/
├── docker-compose.yaml
├── .env.example                 # copy to .env
├── infra/postgres/init.sql      # creates the 3 DBs and users
├── api-gateway/                 # routing table, JWT, rate limits
├── services/
│   ├── product/
│   ├── inventory/
│   └── order/                   # Phases 4–5
├── client/                      # Phase 6
├── PLAN.md                      # design and phase plan
└── PROGRESS.md                  # where the build is now
```

---

## Roadmap

| Phase | What | Status |
|---|---|---|
| 0 | Infrastructure: Postgres, RabbitMQ, Adminer | ✅ |
| 1 | Inventory service | ✅ |
| 2 | Product service + sync call to inventory | ✅ |
| 3 | API gateway + JWT | ✅ |
| 4 | Order service (sync part) | ⏳ |
| 5 | RabbitMQ saga (order ↔ inventory) | ⏳ |
| 6 | React client | ⏳ |
| 7 | Docker polish: health checks, prod images, seed data | ⏳ |
| 8 | Stretch: DLQ, outbox, tests, Cart/Email/Auth services, Kong | optional |

[PROGRESS.md](PROGRESS.md) has the live status and the decision log.
