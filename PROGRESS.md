# Progress Tracker

> Resume here. Read `PLAN.md` for the design. Update this file at the end of every phase.

**Current phase:** Phase 3 done → waiting for user check, then **Phase 4 (Order service, sync part)**
**Last updated:** 2026-11-10

| Phase | Title | Status | Notes |
|---|---|---|---|
| 0 | Workspace + infra (Postgres, RabbitMQ, Adminer) | ✅ done | 3 DBs, each with its own user; cross-DB connect refused |
| 1 | Inventory service | ✅ done | 5 endpoints + /health; race test: 20 parallel OUT on stock 12 → 12×200, 8×409, stock 0 |
| 2 | Product service + sync call to Inventory | ✅ done | F1 with compensation (inventory down → 503, product deleted); F2 → stock:null on stop (fast DNS fail) and on pause (2s timeout) |
| 3 | API gateway + JWT | ✅ done (awaiting user check) | 11 routes from config.json; 401/403/201 verified; forged x-user-* headers stripped (proved with an echo container aliased as order-service); services' ports removed |
| 4 | Order service (sync part) | ⏳ todo | |
| 5 | RabbitMQ saga (order ↔ inventory) | ⏳ todo | |
| 6 | React client | ⏳ todo | |
| 7 | Full Docker polish (healthchecks, prod images, seed) | ⏳ todo | |
| 8 | Stretch (DLQ, outbox, tests, extra services, Kong) | ⏳ optional | |

## Decision log
- 2026-11-10 — 3 services: Product, Inventory, Order. Custom Express gateway. JWT checked in the gateway. One Postgres container with 3 DBs. Work phase by phase, Claude explains each step.

- 2026-11-10 — Phase 0: each service gets its own Postgres **user** too (not only its own DB), and REVOKE CONNECT FROM PUBLIC, so isolation is enforced by the DB rather than by convention. Svc users have CREATEDB for Prisma's shadow DB. Host has Node 18 / no yarn → everything runs on node:20 in Docker.
- 2026-11-10 — Phase 1: Prisma **6** (not 7, which needs driver adapters + prisma.config.ts), Express **5** (async errors reach the handler automatically), Zod **4**. Stock changes use a conditional `updateMany WHERE available >= qty` (atomic) instead of read-check-write. RESERVE/RELEASE are rejected by the admin API, only the saga may use them. Compose `init: true` + `exec` in CMD for graceful SIGTERM. Migrations are created with `docker compose run --rm <svc> yarn prisma migrate dev --name X`, then chown the files (container runs as root).
- 2026-11-10 — Phase 2: F1 uses a **compensating delete** (no distributed transaction). Product list has no stock (avoids N+1 HTTP calls); detail page has it. product-service does NOT `depends_on` inventory. Price is Decimal(10,2), validated as a string with max 2 decimals; Prisma prints it without trailing zeros ("18"), so the UI formats it. **Gotcha found:** Zod 4 `.partial()` keeps `.default()`s → update schema must be built from a base without defaults.
- 2026-11-10 — Phase 3: route table = list of {method, path, service, roles} (more precise than prefix-only). Gateway strips client `x-user-*` headers globally, then sets them from the verified JWT. `express.json()` only on /auth/login so proxied bodies stream untouched. JWT HS256 pinned. Demo users `admin@shop.test/admin123`, `user@shop.test/user123`. `POST /inventories` is deliberately NOT routed (internal, product-service only). Login limit 10/min, global 300/min. Services no longer publish host ports; Authorization header is still forwarded to services (harmless, could be stripped later).

## Open questions
- (none yet)
