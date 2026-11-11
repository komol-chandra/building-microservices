import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { errorMessage } from '../api';
import ErrorBox from '../components/ErrorBox';

/** New accounts are always role "user". There is no role field: the server would ignore it anyway. */
export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(name, email, password);
      navigate('/');
    } catch (err) {
      setError(errorMessage(err)); // e.g. 409 "This email is already registered"
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Create account</h1>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></label>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </label>
        <ErrorBox error={error} />
        <button disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="muted">Already have one? <Link to="/login">Log in</Link></p>
        <Link to="/">← Back to products</Link>
      </form>
    </div>
  );
}
