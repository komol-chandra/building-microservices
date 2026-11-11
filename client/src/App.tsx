import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './auth';
import type { Role } from './api';
import Layout from './components/Layout';
import Login from './pages/Login';
import Products from './pages/Products';
import ProductDetail from './pages/ProductDetail';
import NewProduct from './pages/NewProduct';
import Cart from './pages/Cart';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';

/** UI-side guard only (hides pages). The gateway enforces the same rule for real. */
function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Products />} />
        <Route path="/products/new" element={<RequireAuth role="admin"><NewProduct /></RequireAuth>} />
        <Route path="/products/:id" element={<ProductDetail />} />
        <Route path="/cart" element={<RequireAuth><Cart /></RequireAuth>} />
        <Route path="/orders" element={<RequireAuth><Orders /></RequireAuth>} />
        <Route path="/orders/:id" element={<RequireAuth><OrderDetail /></RequireAuth>} />
        <Route path="*" element={<p>Page not found.</p>} />
      </Route>
    </Routes>
  );
}
