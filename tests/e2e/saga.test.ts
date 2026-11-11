/**
 * End-to-end: the whole system, through the gateway, the way the React client uses it.
 * Needs a running stack (dev or prod).   docker compose --profile test run --rm e2e
 *
 * Every run creates its own products (unique SKUs), so it never depends on, or
 * breaks, the seed data or earlier runs.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8081';
const RABBIT_API = process.env.RABBITMQ_API_URL ?? 'http://rabbitmq:15672/api';
const RABBIT_AUTH = 'Basic ' + Buffer.from(process.env.RABBITMQ_API_CREDENTIALS ?? 'guest:guest').toString('base64');
const RUN = Date.now().toString(36);

interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = any>(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res<T>> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T, headers: res.headers };
}

const login = async (email: string, password: string) => (await call('POST', '/auth/login', { body: { email, password } })).body.accessToken as string;

/** The saga is async: poll until the order leaves PENDING. */
async function waitForFinal(orderId: string, token: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { body } = await call('GET', `/orders/${orderId}`, { token });
    if (body.status !== 'PENDING') return body;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`order ${orderId} still PENDING after ${timeoutMs}ms`);
}

const stockOf = async (productId: string) => (await call('GET', `/inventories/product/${productId}`)).body;

let admin: string;
let user: string;

async function createProduct(sku: string, quantity: number, price = '10.00') {
  const res = await call('POST', '/products', { token: admin, body: { sku: `${sku}-${RUN}`, name: `E2E ${sku}`, price, status: 'PUBLISHED', quantity } });
  expect(res.status).toBe(201);
  return res.body as { id: string; stock: { inventoryId: string; available: number } };
}

async function placeOrder(items: Array<{ productId: string; quantity: number }>, token = user, headers?: Record<string, string>) {
  const res = await call('POST', '/orders', { token, body: { items }, headers });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('PENDING');
  return res;
}

beforeAll(async () => {
  admin = await login('admin@shop.test', 'admin123');
  user = await login('user@shop.test', 'user123');
  expect(admin).toBeTruthy();
  expect(user).toBeTruthy();
});

describe('platform', () => {
  it('gateway and every service are up', async () => {
    const { status, body } = await call('GET', '/health');
    expect(status).toBe(200);
    expect(body.services).toEqual({ product: 'up', inventory: 'up', order: 'up', auth: 'up' });
  });

  it('echoes the correlation id', async () => {
    const id = `e2e-${randomUUID()}`;
    const { headers } = await call('GET', '/products?limit=1', { headers: { 'x-request-id': id } });
    expect(headers.get('x-request-id')).toBe(id);
  });
});

describe('edge auth', () => {
  it('401 without a token, 403 with the wrong role', async () => {
    expect((await call('POST', '/products', { body: {} })).status).toBe(401);
    expect((await call('POST', '/products', { token: user, body: {} })).status).toBe(403);
  });

  it('ignores forged x-user-* headers', async () => {
    const res = await call('POST', '/products', { token: user, body: {}, headers: { 'x-user-role': 'admin' } });
    expect(res.status).toBe(403);
  });

  it('does not route internal endpoints', async () => {
    expect((await call('POST', '/inventories', { token: admin, body: { productId: 'x' } })).status).toBe(404);
  });
});

describe('auth-service (Phase 9)', () => {
  const email = `e2e-${RUN}@Shop.Test`;
  let token: string;

  it('register → 201, always role user (a role in the body is ignored), logged in at once', async () => {
    const res = await call('POST', '/auth/register', { body: { email, name: 'E2E কমল', password: 'password123', role: 'admin' } });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: email.toLowerCase(), name: 'E2E কমল', role: 'user' });
    token = res.body.accessToken;
    expect((await call('GET', '/auth/me', { token })).body).toMatchObject({ email: email.toLowerCase(), role: 'user' });
  });

  it('same email in other casing → 409', async () => {
    const res = await call('POST', '/auth/register', { body: { email: email.toUpperCase(), name: 'x', password: 'password123' } });
    expect(res.status).toBe(409);
  });

  it('login: wrong password and unknown email look the same', async () => {
    const a = await call('POST', '/auth/login', { body: { email, password: 'wrong-password' } });
    const b = await call('POST', '/auth/login', { body: { email: `nobody-${RUN}@shop.test`, password: 'wrong-password' } });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body).toEqual(b.body);
  });

  it('a new user can order; a non-ASCII name survives the x-user-name header', async () => {
    const p = await createProduct('AUTHMUG', 2);
    const { body } = await placeOrder([{ productId: p.id, quantity: 1 }], token);
    expect(body.userName).toBe('E2E কমল');
    expect((await waitForFinal(body.id, token)).status).toBe('CONFIRMED');
  });

  it('JWKS publishes public keys only', async () => {
    const { body } = await call('GET', '/.well-known/jwks.json');
    expect(body.keys.length).toBeGreaterThan(0);
    for (const k of body.keys) {
      expect(k).toMatchObject({ kty: 'RSA', alg: 'RS256' });
      expect(k.d).toBeUndefined(); // private exponent never leaves auth-service
    }
  });

  it('a token with a tampered payload (role → admin) is rejected', async () => {
    const [h, p, sig] = token.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const forged = [h, Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url'), sig].join('.');
    expect((await call('GET', '/users', { token: forged })).status).toBe(401);
  });

  it('user admin endpoints: 403 for users, list for admins without password hashes', async () => {
    expect((await call('GET', '/users', { token })).status).toBe(403);
    const { status, body } = await call('GET', '/users', { token: admin });
    expect(status).toBe(200);
    expect(body.data.some((u: any) => u.email === email.toLowerCase())).toBe(true);
    expect(body.data.every((u: any) => !('passwordHash' in u))).toBe(true);
  });
});

describe('order saga', () => {
  let p1: Awaited<ReturnType<typeof createProduct>>;
  let confirmedOrderId: string;

  beforeAll(async () => {
    p1 = await createProduct('BOTTLE', 3, '24.00');
  });

  it('creating a product also creates its stock (F1)', async () => {
    expect(p1.stock.available).toBe(3);
    expect((await call('GET', `/products/${p1.id}`)).body.stock).toMatchObject({ available: 3, reserved: 0 });
  });

  it('enough stock → CONFIRMED, stock moves from available to reserved', async () => {
    const { body } = await placeOrder([{ productId: p1.id, quantity: 2 }]);
    const done = await waitForFinal(body.id, user);
    expect(done.status).toBe('CONFIRMED');
    expect(done.grandTotal).toBe('50.4'); // 48.00 + 5% tax; Prisma prints Decimals without trailing zeros
    expect(await stockOf(p1.id)).toMatchObject({ availableQuantity: 1, reservedQuantity: 2 });
    confirmedOrderId = body.id;
  });

  it('the reservation is in the stock history, linked to the order', async () => {
    const { body } = await call('GET', `/inventories/${p1.stock.inventoryId}/history`, { token: admin });
    expect(body.data.find((h: any) => h.actionType === 'RESERVE')).toMatchObject({ orderId: confirmedOrderId, quantityChanged: 2 });
  });

  it('not enough stock → FAILED with a reason, nothing reserved', async () => {
    const { body } = await placeOrder([{ productId: p1.id, quantity: 5 }]);
    const done = await waitForFinal(body.id, user);
    expect(done.status).toBe('FAILED');
    expect(done.failureReason).toContain('Insufficient stock');
    expect(await stockOf(p1.id)).toMatchObject({ availableQuantity: 1, reservedQuantity: 2 });
  });

  it('all or nothing: one short item fails the whole order', async () => {
    const p2 = await createProduct('MUG', 10);
    const { body } = await placeOrder([
      { productId: p2.id, quantity: 1 },
      { productId: p1.id, quantity: 5 },
    ]);
    expect((await waitForFinal(body.id, user)).status).toBe('FAILED');
    expect(await stockOf(p2.id)).toMatchObject({ availableQuantity: 10, reservedQuantity: 0 });
  });

  it('a draft product cannot be ordered', async () => {
    const draft = await call('POST', '/products', { token: admin, body: { sku: `DRAFT-${RUN}`, name: 'Draft', price: '1.00', quantity: 5 } });
    const res = await call('POST', '/orders', { token: user, body: { items: [{ productId: draft.body.id, quantity: 1 }] } });
    expect(res.status).toBe(400);
  });

  it('line items are a snapshot: editing the product does not rewrite the order', async () => {
    await call('PUT', `/products/${p1.id}`, { token: admin, body: { price: '99.00', name: 'Renamed' } });
    const { body } = await call('GET', `/orders/${confirmedOrderId}`, { token: user });
    expect(body.items[0]).toMatchObject({ price: '24', productName: 'E2E BOTTLE' });
  });

  it("another user's order is a 404, not a 403", async () => {
    expect((await call('GET', `/orders/${confirmedOrderId}`, { token: admin })).status).toBe(404);
  });

  it('no overselling under concurrency: 10 parallel orders on a stock of 6', async () => {
    const p = await createProduct('RACE', 6);
    const placed = await Promise.all(Array.from({ length: 10 }, () => placeOrder([{ productId: p.id, quantity: 1 }])));
    const finals = await Promise.all(placed.map((r) => waitForFinal(r.body.id, user)));
    const count = (s: string) => finals.filter((o) => o.status === s).length;
    expect(count('CONFIRMED')).toBe(6);
    expect(count('FAILED')).toBe(4);
    expect(await stockOf(p.id)).toMatchObject({ availableQuantity: 0, reservedQuantity: 6 });
  });
});

describe('dead-letter queue', () => {
  const rabbit = (path: string, body?: unknown) =>
    fetch(`${RABBIT_API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: RABBIT_AUTH, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json());

  it('a malformed order.placed is parked in inventory.order-placed.dlq, not lost or looped', async () => {
    const marker = `e2e-garbage-${RUN}`;
    const published = await rabbit('/exchanges/%2F/ecommerce.events/publish', {
      properties: { delivery_mode: 2, correlation_id: marker },
      routing_key: 'order.placed',
      payload: JSON.stringify({ marker }),
      payload_encoding: 'string',
    });
    expect(published.routed).toBe(true);

    // Peek (requeue) until our message shows up. Management stats lag, the queue itself doesn't.
    const until = Date.now() + 15_000;
    let found: any;
    while (!found && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      const msgs = await rabbit('/queues/%2F/inventory.order-placed.dlq/get', { count: 100, ackmode: 'ack_requeue_true', encoding: 'auto' });
      found = msgs.find((m: any) => m.properties.correlation_id === marker);
    }
    expect(found).toBeTruthy();
    expect(found.properties.headers['x-last-error']).toMatch(/^invalid message/);
    expect(found.properties.headers['x-original-routing-key']).toBe('order.placed');
  });
});
