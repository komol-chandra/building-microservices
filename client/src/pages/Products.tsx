import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, money, type Page, type Product } from '../api';
import { useAuth } from '../auth';
import StatusBadge from '../components/StatusBadge';
import ErrorBox from '../components/ErrorBox';

export default function Products() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<Product> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Shoppers only see PUBLISHED products; the admin sees drafts too.
    const params = { page, limit: 12, ...(isAdmin ? {} : { status: 'PUBLISHED' }) };
    api
      .get<Page<Product>>('/products', { params })
      .then((r) => { setResult(r.data); setError(null); })
      .catch((err) => setError(errorMessage(err)));
  }, [page, isAdmin]);

  return (
    <>
      <div className="page-head">
        <h1>Products</h1>
        {isAdmin && <Link className="button" to="/products/new">+ New product</Link>}
      </div>
      <ErrorBox error={error} />
      {result && result.data.length === 0 && <p className="muted">No products yet.</p>}
      <div className="grid">
        {result?.data.map((p) => (
          <Link key={p.id} to={`/products/${p.id}`} className="card product-card">
            <div className="row">
              <strong>{p.name}</strong>
              {isAdmin && <StatusBadge status={p.status} />}
            </div>
            <span className="muted">{p.sku}</span>
            <span className="price">${money(p.price)}</span>
          </Link>
        ))}
      </div>
      {/* No stock on the list on purpose: it would be one inventory call per product (N+1). */}
      {result && result.meta.totalPages > 1 && (
        <div className="pager">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
          <span>Page {page} / {result.meta.totalPages}</span>
          <button disabled={page >= result.meta.totalPages} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      )}
    </>
  );
}
