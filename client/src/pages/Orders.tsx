import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, money, type Order, type Page } from '../api';
import StatusBadge from '../components/StatusBadge';
import ErrorBox from '../components/ErrorBox';

export default function Orders() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;

    async function load() {
      try {
        const { data } = await api.get<Page<Order>>('/orders', { params: { limit: 50 } });
        if (cancelled) return;
        setOrders(data.data);
        setError(null);
        // Keep refreshing only while some order is still waiting for inventory.
        if (data.data.some((o) => o.status === 'PENDING')) timer = window.setTimeout(load, 2000);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    }
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  return (
    <>
      <h1>My orders</h1>
      <ErrorBox error={error} />
      {orders?.length === 0 && <p className="muted">No orders yet.</p>}
      {orders && orders.length > 0 && (
        <table className="card">
          <thead>
            <tr><th>Order</th><th>Placed</th><th>Items</th><th>Total</th><th>Status</th></tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td><Link to={`/orders/${o.id}`}>{o.id.slice(0, 8)}</Link></td>
                <td>{new Date(o.createdAt).toLocaleString()}</td>
                <td>{o.items.map((i) => `${i.quantity}× ${i.productName}`).join(', ')}</td>
                <td>${money(o.grandTotal)}</td>
                <td><StatusBadge status={o.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
