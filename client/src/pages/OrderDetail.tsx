import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage, money, type Order } from '../api';
import StatusBadge from '../components/StatusBadge';
import ErrorBox from '../components/ErrorBox';

const POLL_MS = 1000;

/**
 * POST /orders answered 201 + PENDING: "accepted, not finished".
 * The real answer comes later through RabbitMQ (order.placed → inventory → inventory.reserved|failed),
 * and the browser can't listen to RabbitMQ. So we POLL GET /orders/:id until the status is final.
 * (Alternatives: WebSocket / Server-Sent Events pushed from the server.)
 */
export default function OrderDetail() {
  const { id } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;

    async function load() {
      try {
        const { data } = await api.get<Order>(`/orders/${id}`);
        if (cancelled) return;
        setOrder(data);
        setError(null);
        setPolls((n) => n + 1);
        if (data.status === 'PENDING') timer = window.setTimeout(load, POLL_MS);
      } catch (err) {
        if (cancelled) return;
        setError(errorMessage(err));
        timer = window.setTimeout(load, POLL_MS * 3); // gateway/order-service hiccup: keep trying, slower
      }
    }
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [id]);

  if (!order) return error ? <ErrorBox error={error} /> : <p className="muted">Loading…</p>;

  const waitedMs = new Date(order.updatedAt).getTime() - new Date(order.createdAt).getTime();

  return (
    <>
      <Link to="/orders">← My orders</Link>
      <div className="card">
        <div className="row">
          <h1>Order {order.id.slice(0, 8)}</h1>
          <StatusBadge status={order.status} />
        </div>

        {order.status === 'PENDING' && (
          <p className="pending">
            <span className="spinner" /> Waiting for inventory to reserve stock… (checked {polls}×)
            <br />
            <span className="muted">If inventory-service is stopped, the message waits in RabbitMQ and this page keeps waiting.</span>
          </p>
        )}
        {order.status === 'CONFIRMED' && <p className="ok">Stock reserved. Confirmed {(waitedMs / 1000).toFixed(1)}s after placing.</p>}
        {order.status === 'FAILED' && <p className="error">Failed: {order.failureReason ?? 'unknown reason'}</p>}
        <ErrorBox error={error} />

        <table>
          <thead>
            <tr><th>Product</th><th>SKU</th><th>Price</th><th>Qty</th><th>Total</th></tr>
          </thead>
          <tbody>
            {/* Snapshot: name/sku/price as they were when the order was placed. */}
            {order.items.map((i) => (
              <tr key={i.id}>
                <td><Link to={`/products/${i.productId}`}>{i.productName}</Link></td>
                <td className="muted">{i.sku}</td>
                <td>${money(i.price)}</td>
                <td>{i.quantity}</td>
                <td>${money(i.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={4}>Subtotal</td><td>${money(order.subtotal)}</td></tr>
            {Number(order.discount) > 0 && <tr><td colSpan={4}>Discount</td><td>-${money(order.discount)}</td></tr>}
            <tr><td colSpan={4}>Tax</td><td>${money(order.tax)}</td></tr>
            <tr><th colSpan={4}>Grand total</th><th>${money(order.grandTotal)}</th></tr>
          </tfoot>
        </table>
        <p className="muted">Placed {new Date(order.createdAt).toLocaleString()}</p>
      </div>
    </>
  );
}
