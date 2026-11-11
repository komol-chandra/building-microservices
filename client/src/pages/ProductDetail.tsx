import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage, money, type Product, type ProductStatus, type StockHistory } from '../api';
import { useAuth } from '../auth';
import { useCart } from '../cart';
import StatusBadge from '../components/StatusBadge';
import ErrorBox from '../components/ErrorBox';

export default function ProductDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);

  // F2: one call, but product-service composes it from TWO services (product_db + inventory).
  const reload = useCallback(() => {
    api
      .get<Product>(`/products/${id}`)
      .then((r) => { setProduct(r.data); setError(null); })
      .catch((err) => setError(errorMessage(err)));
  }, [id]);
  useEffect(reload, [reload]);

  if (error) return <ErrorBox error={error} />;
  if (!product) return <p className="muted">Loading…</p>;

  const inventoryId = product.stock?.inventoryId ?? product.inventoryId;

  return (
    <>
      <Link to="/">← Products</Link>
      <div className="card">
        <div className="row">
          <h1>{product.name}</h1>
          <StatusBadge status={product.status} />
        </div>
        <p className="muted">SKU {product.sku}</p>
        {product.description && <p>{product.description}</p>}
        <p className="price">${money(product.price)}</p>
        <StockLine product={product} />
        {product.status === 'PUBLISHED' && <AddToCart product={product} />}
      </div>

      {user?.role === 'admin' && (
        <>
          <EditProduct product={product} onSaved={reload} />
          {inventoryId && <StockPanel inventoryId={inventoryId} onChanged={reload} />}
        </>
      )}
    </>
  );
}

function StockLine({ product }: { product: Product }) {
  // stock === null means inventory-service didn't answer. The product still shows (partial failure).
  if (product.stock === null) return <p className="warn">Stock unknown right now (inventory service is unavailable).</p>;
  if (!product.stock) return null;
  const { available, reserved } = product.stock;
  return (
    <p>
      {available > 0 ? <strong>{available} in stock</strong> : <strong className="warn">Out of stock</strong>}
      {reserved > 0 && <span className="muted"> · {reserved} reserved by orders</span>}
    </p>
  );
}

function AddToCart({ product }: { product: Product }) {
  const { user } = useAuth();
  const { add } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  if (!user) return <p><Link to="/login">Log in</Link> to order.</p>;
  return (
    <div className="row start">
      <input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} className="qty" />
      {/* Not capped at the shown stock on purpose: try ordering more than available and watch the saga FAIL it. */}
      <button onClick={() => { add(product, qty); setAdded(true); }}>Add to cart</button>
      {added && <Link to="/cart">Added → go to cart</Link>}
    </div>
  );
}

// ---------------- admin only ----------------

function EditProduct({ product, onSaved }: { product: Product; onSaved: () => void }) {
  const [form, setForm] = useState({ name: product.name, price: money(product.price), status: product.status });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      await api.put(`/products/${product.id}`, form);
      setMsg('Saved. Orders placed before keep their old name and price (snapshot).');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Edit product</h2>
      <div className="row">
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Price<input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
        <label>
          Status
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ProductStatus })}>
            <option>DRAFT</option>
            <option>PUBLISHED</option>
            <option>UNLISTED</option>
          </select>
        </label>
      </div>
      <ErrorBox error={error} />
      {msg && <p className="ok">{msg}</p>}
      <button>Save</button>
    </form>
  );
}

function StockPanel({ inventoryId, onChanged }: { inventoryId: string; onChanged: () => void }) {
  const [form, setForm] = useState({ actionType: 'IN', quantity: '10', reason: '' });
  const [history, setHistory] = useState<StockHistory[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    api
      .get<{ data: StockHistory[] }>(`/inventories/${inventoryId}/history`, { params: { limit: 20 } })
      .then((r) => setHistory(r.data.data))
      .catch((err) => setError(errorMessage(err)));
  }, [inventoryId]);
  useEffect(loadHistory, [loadHistory]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      // Goes to inventory-service directly (through the gateway), not via product-service.
      await api.put(`/inventories/${inventoryId}`, {
        actionType: form.actionType,
        quantity: Number(form.quantity),
        reason: form.reason || undefined,
      });
      loadHistory();
      onChanged();
    } catch (err) {
      setError(errorMessage(err)); // e.g. 409 Insufficient stock on OUT
    }
  }

  return (
    <div className="card">
      <h2>Stock</h2>
      <form className="row start" onSubmit={submit}>
        <select value={form.actionType} onChange={(e) => setForm({ ...form, actionType: e.target.value })}>
          <option value="IN">IN (add)</option>
          <option value="OUT">OUT (remove)</option>
        </select>
        <input type="number" min={1} className="qty" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
        <input placeholder="Reason (optional)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        <button>Apply</button>
      </form>
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr><th>When</th><th>Action</th><th>Qty</th><th>Available</th><th>Reason / order</th></tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id}>
              <td>{new Date(h.createdAt).toLocaleString()}</td>
              <td><StatusBadge status={h.actionType} /></td>
              <td>{h.quantityChanged}</td>
              <td>{h.lastQuantity} → {h.currentQuantity}</td>
              <td className="muted">{h.reason ?? ''}{h.orderId && ` ${h.orderId.slice(0, 8)}`}</td>
            </tr>
          ))}
          {history.length === 0 && <tr><td colSpan={5} className="muted">No history yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
