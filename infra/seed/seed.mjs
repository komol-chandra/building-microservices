// Seeds demo products + stock THROUGH THE GATEWAY, like a real admin would.
//
// Why not INSERT straight into the databases? Creating a product touches TWO
// databases (product_db + inventory_db) and product-service is the one that keeps
// them in step (F1 + compensation). Going through the API reuses that logic
// instead of duplicating it in SQL, and it can't put the data in a state the
// services would never create themselves.
//
// Idempotent: products whose SKU already exists are skipped, so running it
// again (every `docker compose up`) changes nothing.
//
// Plain Node 20 (built-in fetch), no dependencies, so no image build is needed.

const GATEWAY = process.env.GATEWAY_URL ?? 'http://api-gateway:8081';
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@shop.test';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'admin123';

const PRODUCTS = [
  { sku: 'MUG-01', name: 'Ceramic Mug', price: '8.00', quantity: 50, description: '350 ml, dishwasher safe.' },
  { sku: 'TSHIRT-M', name: 'Logo T-Shirt (M)', price: '19.99', quantity: 25, description: '100% cotton.' },
  { sku: 'HOODIE-L', name: 'Zip Hoodie (L)', price: '45.50', quantity: 10 },
  { sku: 'STICKER-PK', name: 'Sticker Pack', price: '3.25', quantity: 200 },
  { sku: 'NOTEBOOK-A5', name: 'A5 Notebook', price: '6.75', quantity: 40 },
  { sku: 'BOTTLE-750', name: 'Steel Water Bottle', price: '24.00', quantity: 3, description: 'Low stock: order 4+ to see the saga FAIL.' },
  { sku: 'CAP-BLK', name: 'Black Cap', price: '15.00', quantity: 0, description: 'Out of stock: every order FAILS.' },
  { sku: 'PROTO-01', name: 'Prototype Lamp', price: '99.00', quantity: 5, status: 'DRAFT', description: 'Draft: only admin sees it; ordering it → 400.' },
];

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const { accessToken } = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });

  const existing = new Set();
  for (let page = 1; ; page++) {
    const { data, meta } = await call('GET', `/products?limit=100&page=${page}`);
    data.forEach((p) => existing.add(p.sku));
    if (page >= meta.totalPages) break;
  }

  let created = 0;
  for (const p of PRODUCTS) {
    if (existing.has(p.sku)) {
      console.log(`[seed] skip   ${p.sku} (exists)`);
      continue;
    }
    const saved = await call('POST', '/products', { token: accessToken, body: { status: 'PUBLISHED', ...p } });
    console.log(`[seed] create ${p.sku} → ${saved.id} (stock ${saved.stock?.available})`);
    created++;
  }
  console.log(`[seed] done: ${created} created, ${PRODUCTS.length - created} already there`);
}

main().catch((e) => {
  console.error(`[seed] FAILED: ${e.message}`);
  process.exit(1);
});
