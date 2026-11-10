import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

export type Role = 'user' | 'admin';

/** What we put inside the token. `sub` (subject) is the standard JWT field for the user id. */
export interface Claims {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

const SECRET: string = process.env.JWT_SECRET ?? '';
if (!SECRET) throw new Error('JWT_SECRET is not set');
const EXPIRES_IN = (process.env.JWT_EXPIRES_IN ?? '1h') as jwt.SignOptions['expiresIn'];

// Demo users. A real system has an Auth/User service with hashed passwords (Phase 8 stretch).
const USERS: Array<Claims & { password: string }> = [
  {
    sub: '11111111-1111-4111-8111-111111111111',
    email: 'admin@shop.test',
    name: 'Shop Admin',
    role: 'admin',
    password: process.env.DEMO_ADMIN_PASSWORD ?? 'admin123',
  },
  {
    sub: '22222222-2222-4222-8222-222222222222',
    email: 'user@shop.test',
    name: 'Demo User',
    role: 'user',
    password: process.env.DEMO_USER_PASSWORD ?? 'user123',
  },
];

/** Constant-time compare, so response timing doesn't leak how much of the password matched. */
function samePassword(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });

// POST /auth/login
export const login: RequestHandler = (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'ValidationError', message: 'email and password are required' });
    return;
  }
  const user = USERS.find((u) => u.email === parsed.data.email);
  // Same message for "no such user" and "wrong password": don't reveal which emails exist.
  if (!user || !samePassword(user.password, parsed.data.password)) {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password' });
    return;
  }
  const { password: _pw, ...claims } = user;
  const accessToken = jwt.sign(claims, SECRET, { algorithm: 'HS256', expiresIn: EXPIRES_IN });
  res.json({ accessToken, tokenType: 'Bearer', expiresIn: EXPIRES_IN, user: claims });
};

/** Returns the verified claims, or null. Pinning the algorithm blocks the "alg: none" trick. */
export function verifyToken(header: string | undefined): Claims | null {
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), SECRET, { algorithms: ['HS256'] }) as Claims;
  } catch {
    return null; // expired, bad signature, malformed...
  }
}

// GET /auth/me — handy for the UI and for debugging tokens.
export const me: RequestHandler = (req, res) => {
  const claims = verifyToken(req.headers.authorization);
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token' });
    return;
  }
  res.json(claims);
};

export const IDENTITY_HEADERS = ['x-user-id', 'x-user-email', 'x-user-name', 'x-user-role'] as const;

/**
 * Edge auth for one route.
 *   roles = []               → public
 *   roles = ['admin']        → must be logged in AND be admin
 * On success, the identity is passed to the service as trusted headers.
 */
export function authorize(roles: Role[]): RequestHandler {
  return (req, res, next) => {
    if (roles.length === 0) return next();

    const claims = verifyToken(req.headers.authorization);
    if (!claims) {
      res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token' });
      return;
    }
    if (!roles.includes(claims.role)) {
      res.status(403).json({ error: 'Forbidden', message: `Requires role: ${roles.join(' or ')}` });
      return;
    }
    req.headers['x-user-id'] = claims.sub;
    req.headers['x-user-email'] = claims.email;
    req.headers['x-user-name'] = claims.name;
    req.headers['x-user-role'] = claims.role;
    next();
  };
}
