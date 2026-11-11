# Progress Tracker

> Resume here. Read `PLAN.md` for the design. Update this file at the end of every phase.

**Current phase:** Phase 5 done → waiting for user check, then **Phase 6 (React client)**
**Last updated:** 2026-11-10

| Phase | Title | Status | Notes |
|---|---|---|---|
| 0 | Workspace + infra (Postgres, RabbitMQ, Adminer) | ✅ done | 3 DBs, each with its own user; cross-DB connect refused |
| 1 | Inventory service | ✅ done | 5 endpoints + /health; race test: 20 parallel OUT on stock 12 → 12×200, 8×409, stock 0 |
| 2 | Product service + sync call to Inventory | ✅ done | F1 with compensation (inventory down → 503, product deleted); F2 → stock:null on stop (fast DNS fail) and on pause (2s timeout) |
| 3 | API gateway + JWT | ✅ done | 11 routes from config.json; 401/403/201 verified; forged x-user-* headers stripped (proved with an echo container aliased as order-service); services' ports removed |
| 4 | Order service (sync part) | ✅ done | Order PENDING with snapshot line items; product price/name edit leaves old order unchanged; draft/unknown product → 400; product down → POST 503, GET still 200; other user's order → 404 |
| 5 | RabbitMQ saga (order ↔ inventory) | ✅ done (awaiting user check) | normal → CONFIRMED + RESERVE history; one short item → FAILED, nothing reserved; inventory stopped → message waits in queue, order PENDING → CONFIRMED on restart; same order.placed sent twice by hand → reserved once; garbage message dropped; 20 parallel orders on stock 12 → 12 CONFIRMED / 8 FAILED; RabbitMQ stopped → POST 503 + order FAILED, both services reconnect |
| 6 | React client | ⏳ todo | |
| 7 | Full Docker polish (healthchecks, prod images, seed) | ⏳ todo | |
| 8 | Stretch (DLQ, outbox, tests, extra services, Kong) | ⏳ optional | |

## Decision log
- 2026-11-10 — 3 services: Product, Inventory, Order. Custom Express gateway. JWT checked in the gateway. One Postgres container with 3 DBs. Work phase by phase, Claude explains each step.

- 2026-11-10 — Phase 0: each service gets its own Postgres **user** too (not only its own DB), and REVOKE CONNECT FROM PUBLIC, so isolation is enforced by the DB rather than by convention. Svc users have CREATEDB for Prisma's shadow DB. Host has Node 18 / no yarn → everything runs on node:20 in Docker.
- 2026-11-10 — Phase 1: Prisma **6** (not 7, which needs driver adapters + prisma.config.ts), Express **5** (async errors reach the handler automatically), Zod **4**. Stock changes use a conditional `updateMany WHERE available >= qty` (atomic) instead of read-check-write. RESERVE/RELEASE are rejected by the admin API, only the saga may use them. Compose `init: true` + `exec` in CMD for graceful SIGTERM. Migrations are created with `docker compose run --rm <svc> yarn prisma migrate dev --name X`, then chown the files (container runs as root).
- 2026-11-10 — Phase 2: F1 uses a **compensating delete** (no distributed transaction). Product list has no stock (avoids N+1 HTTP calls); detail page has it. product-service does NOT `depends_on` inventory. Price is Decimal(10,2), validated as a string with max 2 decimals; Prisma prints it without trailing zeros ("18"), so the UI formats it. **Gotcha found:** Zod 4 `.partial()` keeps `.default()`s → update schema must be built from a base without defaults.
- 2026-11-10 — Phase 3: route table = list of {method, path, service, roles} (more precise than prefix-only). Gateway strips client `x-user-*` headers globally, then sets them from the verified JWT. `express.json()` only on /auth/login so proxied bodies stream untouched. JWT HS256 pinned. Demo users `admin@shop.test/admin123`, `user@shop.test/user123`. `POST /inventories` is deliberately NOT routed (internal, product-service only). Login limit 10/min, global 300/min. Services no longer publish host ports; Authorization header is still forwarded to services (harmless, could be stripped later).
- 2026-11-10 — Phase 4: client sends only `{productId, quantity}`, never a price; prices come from product-service. Duplicate productIds are merged. Only PUBLISHED products can be ordered. Totals use Prisma.Decimal, half-up to 2 dp; `TAX_RATE` env (default 0.05), discount fixed at 0 for now. Order + LineItems saved in one nested create (same DB → real transaction). Stock is NOT checked here (Phase 5 saga does it). Orders are scoped to `x-user-id` for every role (admin sees only own orders too); another user's order → 404 not 403. order-service rejects requests without `x-user-id` (401). Does not `depends_on` product-service.
- 2026-11-10 — Phase 5: same `events/rabbit.ts` copied into inventory and order (no shared package). Both services declare the WHOLE topology on connect, so an event published before its consumer ever started is not dropped. Publisher confirms + persistent messages; ack only after the handler's DB commit; invalid (Zod) messages are nacked without requeue, handler errors requeue after 3s (DLQ is Phase 8). Rabbit connect is retried in the background, HTTP serves meanwhile; `/health` shows `rabbit: up|down`. **Inventory also has a ProcessedEvent table** (not only order) and stores the result event it sent, so a duplicate `order.placed` re-sends the same answer instead of reserving twice. All items of an order are reserved in one transaction, locked in productId order (no deadlocks); any shortage rolls back the whole order. Order only moves out of PENDING (late/duplicate events can't flip a final status). If publishing `order.placed` fails the order is marked FAILED and POST returns 503 (compensation); known gap: if the broker actually got the message, stock stays reserved for a FAILED order → outbox in Phase 8. Reserved stock currently stays in `reservedQuantity` (no shipping/release step yet). Gotcha: RabbitMQ management stats lag ~5s. Host DNS gotcha: `yarn add` inside a compose container failed (EAI_AGAIN); ran it with `docker run --network host node:20-slim` instead.

## Open questions
- (none yet)
