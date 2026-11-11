# Sokrio takeaways

Which patterns from this study apply to Sokrio (Laravel 10, multi-tenant, MySQL + MongoDB, a Python benchmark service). Most of them help **inside a monolith** as much as between microservices. None of this says Sokrio has the problem today. Treat each item as a question to check against the real code.

| Pattern (where it lives here) | What it prevents | Laravel equivalent | Check in Sokrio |
|---|---|---|---|
| **Snapshot line items** ([order schema](../services/order/prisma/schema.prisma)) | Old orders and invoices change when a product's name or price is edited | Copy `name`, `sku`, `price` (and the tax/discount used) into the order-line row at order time. Don't join `products` when printing an order. | Do order lines, invoices and reports read the live product price? |
| **Atomic conditional update** ([inventory controller](../services/inventory/src/controllers/inventory.controller.ts)) | Two requests both read stock 5 and both sell 5 | `Stock::where('id', $id)->where('qty', '>=', $n)->decrement('qty', $n)` and check the affected-row count. Don't read, compare in PHP, then save. | Stock, credit limits, target counters, anything "check then write" |
| **Append-only ledger** (`StockHistory`) | "How did the stock get to −3?" | One history row per change in the same `DB::transaction` as the balance update, with `last_qty` / `current_qty` / `reason` / `order_id` | Is every stock or balance change explained by a history row? |
| **Lock rows in a fixed order** ([order-placed handler](../services/inventory/src/events/order-placed.ts)) | Deadlocks when two orders touch the same products in a different order | Sort items by product id before updating them inside the transaction | Multi-item stock moves, bulk updates |
| **All-or-nothing reservation** | Half-reserved orders | One `DB::transaction`; throw on the first shortage, report all shortages | Order approval and delivery flows |
| **Idempotent consumers** (`ProcessedEvent`) | A retried job or webhook applies twice | A `processed_events` table with a unique `event_id`, inserted in the same transaction as the effect. A duplicate hits the unique key and is skipped. | Queued jobs that change data: are they safe to run twice? |
| **Transactional outbox** ([outbox.ts](../services/order/src/events/outbox.ts)) | Row saved but job/event never sent, or job sent for a row that rolled back | Simplest form: dispatch jobs with `->afterCommit()` (or `after_commit` on the queue connection). Full form: an `outbox` table written in the transaction plus a scheduled relay command. | Jobs dispatched inside `DB::transaction` without `afterCommit` |
| **Retry with delay + dead-letter queue** ([rabbit.ts](../services/inventory/src/events/rabbit.ts)) | A poison message retried forever, or silently dropped | `$tries`, `$backoff` and `failed()` on jobs; the `failed_jobs` table is the DLQ. Watch it. | Is anyone looking at `failed_jobs`? |
| **Correlation id** ([context.ts](../services/order/src/context.ts)) | Can't follow one user action across API → job → Python service | Middleware: read or create `X-Request-Id`, `Log::withContext(['rid' => $id])`, put it in job payloads and in HTTP calls to the benchmark service | Can one request be traced from Laravel into the Python benchmark? |
| **Partial failure / graceful degradation** (product with `stock: null`) | One slow dependency breaks a whole page | Timeouts on every `Http::` call, plus a fallback value for optional data | `Http::` calls without `->timeout()` |
| **Edge auth + trusted headers** (gateway) | Services re-implementing auth differently | Only relevant if Sokrio splits services. Inside the monolith, Sanctum and middleware already do this. | n/a for now |
| **Decimal money** ([pricing.ts](../services/order/src/pricing.ts)) | Off-by-a-cent totals (`20.9 * 0.05` rounds to 1.04) | `DECIMAL` columns; `bcmath` or `brick/money` for maths; never `float` | Report totals computed in PHP floats or in JS |
| **Healthchecks + `depends_on: service_healthy`** (compose) | Containers starting before the DB is ready | Same in Sokrio's Docker setup; add a `/health` route that checks the DB | Local Docker startup races |

## What did NOT carry over

- **Database per service.** Sokrio's tenancy is per tenant DB, not per module. Splitting by module would need the snapshot and saga patterns everywhere; not worth it without a strong reason.
- **Choreography sagas.** They're great for learning, but harder to follow than one transaction in a monolith. Use them only where work really spans systems, such as Laravel ↔ the Python benchmark service.
