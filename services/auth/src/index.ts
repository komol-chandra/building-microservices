import express from 'express';
import morgan from 'morgan';
import { prisma } from './prisma';
import { log, MORGAN_FORMAT, requestIdMiddleware } from './context';
import { router } from './routes';
import { errorHandler, notFound } from './errors';
import { loadSigningKey } from './keys';

const SERVICE = 'auth-service';
const PORT = Number(process.env.PORT ?? 4004);

const app = express();
app.use(requestIdMiddleware);
app.use(express.json({ limit: '10kb' }));
app.use(morgan(MORGAN_FORMAT));

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', service: SERVICE, db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', service: SERVICE, db: 'down' });
  }
});

app.use(router);
app.use(notFound);
app.use(errorHandler);

async function main() {
  // The key must be ready before the first login, so load it BEFORE listening.
  // If the DB isn't reachable yet, the process exits and Docker restarts it.
  await loadSigningKey();
  const server = app.listen(PORT, () => log.info(`[${SERVICE}] listening on :${PORT}`));
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log.info(`[${SERVICE}] ${sig} received, shutting down`);
      server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
    });
  }
}

main().catch((e) => {
  log.error(`[${SERVICE}] failed to start: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
