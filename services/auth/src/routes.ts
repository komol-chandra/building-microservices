import { Router } from 'express';
import * as c from './controllers/auth.controller';
import { requireAdmin, requireIdentity } from './identity';

export const router = Router();

router.post('/auth/register', c.register);
router.post('/auth/login', c.login);
router.get('/auth/me', requireIdentity, c.me);
router.get('/.well-known/jwks.json', c.jwks);

router.get('/users', requireAdmin, c.listUsers);
router.put('/users/:id/role', requireAdmin, c.setRole);
