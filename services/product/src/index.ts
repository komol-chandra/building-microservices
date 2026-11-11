import express from 'express';
import morgan from 'morgan';
import { prisma } from './prisma';
import { log, MORGAN_FORMAT, requestIdMiddleware } from './context';
import { productRouter } from './routes';
import { errorHandler, notFound } from './errors';

const SERVICE = 'product-service';
const PORT = Number(process.env.PORT ?? 4001);

const app = express();
app.use(requestIdMiddleware); // first: everything after it (incl. logs) knows the correlation id
app.use(express.json());
app.use(morgan(MORGAN_FORMAT));

// Health = "can I do my job?", so it checks the DB too, not just "process is up".
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', service: SERVICE, db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', service: SERVICE, db: 'down' });
  }
});

app.use('/products', productRouter);
app.use(notFound);
app.use(errorHandler);

const server = app.listen(PORT, () => log.info(`[${SERVICE}] listening on :${PORT}`));

// Graceful shutdown: `docker compose stop` sends SIGTERM.
// Stop accepting requests, finish in-flight ones, close the DB pool.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log.info(`[${SERVICE}] ${sig} received, shutting down`);
    server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
  });
}
