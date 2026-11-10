import { Router } from 'express';
import * as c from './controllers/inventory.controller';

export const inventoryRouter = Router();

// Order matters: '/product/:productId' must come before '/:id'.
inventoryRouter.post('/', c.createInventory);
inventoryRouter.get('/product/:productId', c.getInventoryByProduct);
inventoryRouter.get('/:id', c.getInventory);
inventoryRouter.put('/:id', c.updateStock);
inventoryRouter.get('/:id/history', c.getHistory);
