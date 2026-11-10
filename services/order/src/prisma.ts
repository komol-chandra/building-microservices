import { PrismaClient } from '@prisma/client';

// One client per process. It holds a connection pool to order_db.
export const prisma = new PrismaClient();
