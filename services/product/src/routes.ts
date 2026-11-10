import { Router } from 'express';
import * as c from './controllers/product.controller';

export const productRouter = Router();

productRouter.get('/', c.listProducts);
productRouter.post('/', c.createProduct);
productRouter.get('/:id', c.getProduct);
productRouter.put('/:id', c.updateProduct);
