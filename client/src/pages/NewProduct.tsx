import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage, type Product, type ProductStatus } from '../api';
import ErrorBox from '../components/ErrorBox';

export default function NewProduct() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ sku: '', name: '', description: '', price: '', quantity: '0', status: 'PUBLISHED' as ProductStatus });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // F1: product-service saves the product, then creates its stock row in inventory-service.
      // If inventory is down we get 503 and the product is rolled back (compensation).
      const { data } = await api.post<Product>('/products', {
        ...form,
        description: form.description || undefined,
        quantity: Number(form.quantity),
      });
      navigate(`/products/${data.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h1>New product</h1>
      <label>SKU<input value={form.sku} onChange={set('sku')} required /></label>
      <label>Name<input value={form.name} onChange={set('name')} required /></label>
      <label>Description<textarea value={form.description} onChange={set('description')} rows={3} /></label>
      <div className="row">
        <label>Price<input value={form.price} onChange={set('price')} placeholder="19.99" required /></label>
        <label>Initial stock<input type="number" min={0} value={form.quantity} onChange={set('quantity')} /></label>
        <label>
          Status
          <select value={form.status} onChange={set('status')}>
            <option>DRAFT</option>
            <option>PUBLISHED</option>
            <option>UNLISTED</option>
          </select>
        </label>
      </div>
      <ErrorBox error={error} />
      <button disabled={busy}>{busy ? 'Saving…' : 'Create product'}</button>
    </form>
  );
}
