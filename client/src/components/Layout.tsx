import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useCart } from '../cart';

export default function Layout() {
  const { user, logout } = useAuth();
  const { items } = useCart();
  const navigate = useNavigate();
  const count = items.reduce((n, i) => n + i.quantity, 0);

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">MS Shop</Link>
        <nav>
          <NavLink to="/" end>Products</NavLink>
          {user?.role === 'admin' && <NavLink to="/products/new">New product</NavLink>}
          {user && <NavLink to="/orders">My orders</NavLink>}
          {user && <NavLink to="/cart">Cart{count > 0 && ` (${count})`}</NavLink>}
        </nav>
        <div className="who">
          {user ? (
            <>
              <span>{user.name} <span className="role">{user.role}</span></span>
              <button className="link" onClick={() => { logout(); navigate('/'); }}>Log out</button>
            </>
          ) : (
            <Link to="/login">Log in</Link>
          )}
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
