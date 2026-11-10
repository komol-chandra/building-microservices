import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { IDENTITY_HEADERS, login, me } from './auth';
import { registerRoutes, serviceUrls } from './utils';

const PORT = Number(process.env.PORT ?? 8081);
const app = express();

// 1. Request id: one id follows the request through every service (and its logs).
app.use((req, res, next) => {
  const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('x-request-id', id);
  next();
});

// 2. NEVER trust identity headers from outside. Only the gateway may set them
//    (in authorize(), after verifying the JWT). Otherwise anyone could send
//    "x-user-role: admin" and the services would believe it.
app.use((req, _res, next) => {
  for (const h of IDENTITY_HEADERS) delete req.headers[h];
  next();
});

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? 'http://localhost:5173', exposedHeaders: ['x-request-id'] }));
app.use(morgan(':method :url :status :response-time ms  req=:req[x-request-id]'));

// 3. Rate limits: a general one, and a strict one on login (slows password guessing).
app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 300), standardHeaders: 'draft-7', legacyHeaders: false }));
const loginLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

// 4. Gateway's own endpoints. express.json() ONLY here: proxied routes must
//    keep the raw body stream so it can be piped to the service untouched.
app.post('/auth/login', loginLimiter, express.json(), login);
app.get('/auth/me', me);

// Aggregated health: gateway + every upstream (1s budget each, in parallel).
app.get('/health', async (_req, res) => {
  const entries = await Promise.all(
    Object.entries(serviceUrls()).map(async ([name, url]) => {
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
        return [name, r.ok ? 'up' : `unhealthy (${r.status})`] as const;
      } catch {
        return [name, 'down'] as const;
      }
    }),
  );
  const services = Object.fromEntries(entries);
  const allUp = entries.every(([, s]) => s === 'up');
  res.status(allUp ? 200 : 207).json({ gateway: 'ok', services });
});

// 5. Proxied routes from config.json.
registerRoutes(app);

// 6. Anything not in the route table never reaches a service.
app.use((req, res) => {
  res.status(404).json({ error: 'NotFound', message: `No route ${req.method} ${req.path}` });
});

const server = app.listen(PORT, () => console.log(`[api-gateway] listening on :${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
