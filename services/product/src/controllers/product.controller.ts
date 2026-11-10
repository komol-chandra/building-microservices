import type { Request, Response } from 'express';
import { prisma } from '../prisma';
import { HttpError } from '../errors';
import { createProductSchema, idParam, listQuery, updateProductSchema } from '../schemas';
import { createInventory, describeInventoryError, getStockByProductId } from '../clients/inventory';

/**
 * F1 — POST /products
 *
 * Two databases are involved (product_db + inventory_db), so ONE transaction
 * can't cover both. The steps:
 *   1. save the product (product_db)
 *   2. ask inventory-service to create the stock row (inventory_db)
 *   3a. success → store the returned inventoryId on the product
 *   3b. failure → COMPENSATE: delete the product we just saved, return 503
 *
 * Step 3b is a "compensating action": we undo our own step by hand because
 * nothing rolls it back for us. It's the smallest possible saga.
 */
export async function createProduct(req: Request, res: Response) {
  const { quantity, ...data } = createProductSchema.parse(req.body);

  const product = await prisma.product.create({ data });

  let stock;
  try {
    stock = await createInventory(product.id, quantity);
  } catch (err) {
    await prisma.product.delete({ where: { id: product.id } });
    console.error(`[product] inventory create failed, product ${product.id} rolled back: ${describeInventoryError(err)}`);
    throw new HttpError(503, 'Inventory service unavailable, product was not created. Please retry.');
  }

  const saved = await prisma.product.update({
    where: { id: product.id },
    data: { inventoryId: stock.inventoryId },
  });

  res.status(201).json({ ...saved, stock });
}

/**
 * F2 — GET /products/:id
 * Read composition: product from OUR db + stock from inventory-service.
 * If inventory is down → stock: null, but the product still loads (partial failure).
 */
export async function getProduct(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw new HttpError(404, 'Product not found');

  const stock = await getStockByProductId(product.id);
  res.json({ ...product, stock });
}

/**
 * GET /products?page=&limit=&status=
 * List does NOT include stock. Calling inventory once per row (N+1 over HTTP)
 * would make the list as slow as 20 network calls. The UI reads stock on the
 * detail page. (A batch endpoint is the proper fix if a list ever needs it.)
 */
export async function listProducts(req: Request, res: Response) {
  const { page, limit, status } = listQuery.parse(req.query);
  const where = status ? { status } : {};

  const [data, total] = await Promise.all([
    prisma.product.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.product.count({ where }),
  ]);

  res.json({ data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

// PUT /products/:id   (partial update; never stock)
export async function updateProduct(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  const data = updateProductSchema.parse(req.body);
  const product = await prisma.product.update({ where: { id }, data }); // P2025 → 404 via error handler
  res.json(product);
}
