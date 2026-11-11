import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage, money, type Order } from '../api';
import { useCart } from '../cart';
import ErrorBox from '../components/ErrorBox';

export default function Cart() {
  const { items, setQuantity, clear } = useCart();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Estimate only (cart prices may be stale, and tax is added by the server).
  const estimate = items.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

  async function placeOrder() {
    setBusy(true);
    setError(null);
    try {
      // Only ids + quantities. The server looks up the real prices.
      const { data } = await api.post<Order>('/orders', {
        items: items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      });
      clear();
      navigate(`/orders/${data.id}`); // status is PENDING here; that page waits for the saga
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) return <p className="muted">Your cart is empty. <Link to="/">Browse products</Link></p>;

  return (
    <div className="card">
      <h1>Cart</h1>
      <table>
        <thead>
          <tr><th>Product</th><th>Price</th><th>Qty</th><th>Total</th><th /></tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.productId}>
              <td><Link to={`/products/${i.productId}`}>{i.name}</Link></td>
              <td>${money(i.price)}</td>
              <td>
                <input type="number" min={1} className="qty" value={i.quantity} onChange={(e) => setQuantity(i.productId, Number(e.target.value))} />
              </td>
              <td>${money(Number(i.price) * i.quantity)}</td>
              <td><button className="link" onClick={() => setQuantity(i.productId, 0)}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Estimated subtotal: <strong>${money(estimate)}</strong> <span className="muted">(final price and tax are set by the order service)</span></p>
      <ErrorBox error={error} />
      <button onClick={placeOrder} disabled={busy}>{busy ? 'Placing…' : 'Place order'}</button>
    </div>
  );
}
