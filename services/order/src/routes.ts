import { Router } from 'express';
import * as c from './controllers/order.controller';
import { requireIdentity } from './identity';

export const orderRouter = Router();

orderRouter.use(requireIdentity);
orderRouter.get('/', c.listOrders);
orderRouter.post('/', c.createOrder);
orderRouter.get('/:id', c.getOrder);
