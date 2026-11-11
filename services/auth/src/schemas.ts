import { z } from 'zod';

// trim + lower-case FIRST, then validate (Zod 4 runs z.email()'s format check before .trim()).
const email = z.string().trim().toLowerCase().pipe(z.email()); // one account per address, whatever the casing

// No `role` field: anyone can register, so a new account is ALWAYS a plain user.
// Extra fields (like "role": "admin") are stripped by Zod, not trusted.
export const registerSchema = z.object({
  email,
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

export const setRoleSchema = z.object({ role: z.enum(['user', 'admin']) });
