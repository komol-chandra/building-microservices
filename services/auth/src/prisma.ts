import { PrismaClient } from '@prisma/client';

// One client per process. It holds a connection pool to auth_db.
export const prisma = new PrismaClient();
