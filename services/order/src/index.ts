import express from 'express';
import morgan from 'morgan';
import { prisma } from './prisma';
import { orderRouter } from './routes';
import { errorHandler, notFound } from './errors';
import { closeRabbit, connectRabbit, isRabbitUp, subscribe } from './events/rabbit';
import { handleInventoryResult, inventoryResultSchema } from './events/inventory-result';

const SERVICE = 'order-service';
const PORT = Number(process.env.PORT ?? 4003);

const app = express();
app.use(express.json());
app.use(morgan('dev'));

// Health = "can I do my job?", so it checks the DB too, not just "process is up".
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', service: SERVICE, db: 'up', rabbit: isRabbitUp() ? 'up' : 'down' });
  } catch {
    res.status(503).json({ status: 'degraded', service: SERVICE, db: 'down', rabbit: isRabbitUp() ? 'up' : 'down' });
  }
});

app.use('/orders', orderRouter);
app.use(notFound);
app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`[${SERVICE}] listening on :${PORT}`));

// Saga result: inventory.reserved | inventory.failed → CONFIRMED | FAILED.
// Not awaited: connectRabbit() retries on its own while RabbitMQ starts.
subscribe('order.inventory-result', inventoryResultSchema, handleInventoryResult);
void connectRabbit();

// Graceful shutdown: `docker compose stop` sends SIGTERM.
// Stop accepting requests, finish in-flight ones, close RabbitMQ and the DB pool.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[${SERVICE}] ${sig} received, shutting down`);
    server.close(() => closeRabbit().then(() => prisma.$disconnect()).finally(() => process.exit(0)));
  });
}
