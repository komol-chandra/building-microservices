import express from 'express';
import morgan from 'morgan';
import { prisma } from './prisma';
import { inventoryRouter } from './routes';
import { errorHandler, notFound } from './errors';

const SERVICE = 'inventory-service';
const PORT = Number(process.env.PORT ?? 4002);

const app = express();
app.use(express.json());
app.use(morgan('dev'));

// Health = "can I do my job?", so it checks the DB too, not just "process is up".
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', service: SERVICE, db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', service: SERVICE, db: 'down' });
  }
});

app.use('/inventories', inventoryRouter);
app.use(notFound);
app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`[${SERVICE}] listening on :${PORT}`));

// Graceful shutdown: `docker compose stop` sends SIGTERM.
// Stop accepting requests, finish in-flight ones, close the DB pool.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[${SERVICE}] ${sig} received, shutting down`);
    server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
  });
}
