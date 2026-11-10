# Progress Tracker

> Resume here. Read `PLAN.md` for the design. Update this file at the end of every phase.

**Current phase:** Phase 1 done → waiting for user check, then **Phase 2 (Product service)**
**Last updated:** 2026-11-10

| Phase | Title | Status | Notes |
|---|---|---|---|
| 0 | Workspace + infra (Postgres, RabbitMQ, Adminer) | ✅ done | 3 DBs, each with its own user; cross-DB connect refused |
| 1 | Inventory service | ✅ done (awaiting user check) | 5 endpoints + /health; race test: 20 parallel OUT on stock 12 → 12×200, 8×409, stock 0 |
| 2 | Product service + sync call to Inventory | ⏳ todo | |
| 3 | API gateway + JWT | ⏳ todo | |
| 4 | Order service (sync part) | ⏳ todo | |
| 5 | RabbitMQ saga (order ↔ inventory) | ⏳ todo | |
| 6 | React client | ⏳ todo | |
| 7 | Full Docker polish (healthchecks, prod images, seed) | ⏳ todo | |
| 8 | Stretch (DLQ, outbox, tests, extra services, Kong) | ⏳ optional | |

## Decision log
- 2026-11-10 — 3 services: Product, Inventory, Order. Custom Express gateway. JWT checked in the gateway. One Postgres container with 3 DBs. Work phase by phase, Claude explains each step.

- 2026-11-10 — Phase 0: each service gets its own Postgres **user** too (not only its own DB), and REVOKE CONNECT FROM PUBLIC, so isolation is enforced by the DB rather than by convention. Svc users have CREATEDB for Prisma's shadow DB. Host has Node 18 / no yarn → everything runs on node:20 in Docker.
- 2026-11-10 — Phase 1: Prisma **6** (not 7, which needs driver adapters + prisma.config.ts), Express **5** (async errors reach the handler automatically), Zod **4**. Stock changes use a conditional `updateMany WHERE available >= qty` (atomic) instead of read-check-write. RESERVE/RELEASE are rejected by the admin API, only the saga may use them. Compose `init: true` + `exec` in CMD for graceful SIGTERM. Migrations are created with `docker compose run --rm <svc> yarn prisma migrate dev --name X`, then chown the files (container runs as root).

## Open questions
- (none yet)
