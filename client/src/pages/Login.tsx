import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { errorMessage } from '../api';
import ErrorBox from '../components/ErrorBox';

const DEMO = [
  { label: 'Admin', email: 'admin@shop.test', password: 'admin123' },
  { label: 'User', email: 'user@shop.test', password: 'user123' },
];

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Log in</h1>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <ErrorBox error={error} />
        <button disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
        <p className="muted">
          Demo:{' '}
          {DEMO.map((d) => (
            <button type="button" className="link" key={d.email} onClick={() => { setEmail(d.email); setPassword(d.password); }}>
              {d.label}
            </button>
          ))}
        </p>
        <Link to="/">← Back to products</Link>
      </form>
    </div>
  );
}
