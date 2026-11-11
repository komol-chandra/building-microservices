import type { RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { log } from '../context';
import { HttpError } from '../errors';
import { burnTime, hashPassword, verifyPassword } from '../passwords';
import { loginSchema, registerSchema, setRoleSchema } from '../schemas';
import { signingKey, publicJwks } from '../keys';
import { EXPIRES_IN, publicUser, signAccessToken, type TokenUser } from '../tokens';

async function tokenResponse(user: TokenUser) {
  const accessToken = await signAccessToken(user, signingKey());
  return { accessToken, tokenType: 'Bearer', expiresIn: EXPIRES_IN, user: publicUser(user) };
}

// POST /auth/register  (public) → creates a plain user and logs them in
export const register: RequestHandler = async (req, res) => {
  const body = registerSchema.parse(req.body);
  try {
    const user = await prisma.user.create({
      data: { email: body.email, name: body.name, passwordHash: await hashPassword(body.password) },
    });
    log.info(`[auth] registered ${user.id}`);
    res.status(201).json(await tokenResponse(user));
  } catch (e) {
    // Registration can't hide whether an email exists (the user must be told it's taken).
    // Login can, and does: see below.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new HttpError(409, 'This email is already registered');
    }
    throw e;
  }
};

// POST /auth/login  (public)
export const login: RequestHandler = async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'email and password are required');
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await burnTime(password), false);
  // Same status, message and (roughly) time for "no such user" and "wrong password".
  if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
  res.json(await tokenResponse(user));
};

// GET /auth/me  (any logged-in user) → fresh from the DB, not from the token
export const me: RequestHandler = async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.header('x-user-id')! } });
  if (!user) throw new HttpError(404, 'User not found');
  res.json(publicUser(user));
};

// GET /.well-known/jwks.json  (public) → the public keys the gateway verifies with
export const jwks: RequestHandler = async (_req, res) => {
  res.setHeader('cache-control', 'public, max-age=300');
  res.json(await publicJwks());
};

// GET /users  (admin)
export const listUsers: RequestHandler = async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, name: true, role: true, createdAt: true }, // never the hash
  });
  res.json({ data: users });
};

// PUT /users/:id/role  (admin) → takes effect on that user's NEXT token
export const setRole: RequestHandler = async (req, res) => {
  const { role } = setRoleSchema.parse(req.body);
  const id = String(req.params.id);
  if (id === req.header('x-user-id')) throw new HttpError(400, "You can't change your own role"); // no locking yourself out
  const user = await prisma.user.update({
    where: { id },
    data: { role },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  log.info(`[auth] user ${id} role → ${role}`);
  res.json(user);
};
