import axios, { AxiosError } from 'axios';
import { HttpError } from '../errors';

/**
 * HTTP client for product-service (direct, over the Docker network).
 *
 * Unlike product → inventory reads, there is NO graceful fallback here:
 * we can't price an order without the product, so a failure stops the order.
 */
const http = axios.create({
  baseURL: process.env.PRODUCT_SERVICE_URL ?? 'http://product-service:4001',
  timeout: Number(process.env.PRODUCT_TIMEOUT_MS ?? 2000),
});

export interface ProductDto {
  id: string;
  sku: string;
  name: string;
  price: string; // Decimal comes over JSON as a string ("18" or "19.99")
  status: 'DRAFT' | 'PUBLISHED' | 'UNLISTED';
}

/**
 * Returns the product, or null if it doesn't exist (404).
 * Any other failure (down, timeout, 5xx) → 503: the client may retry later.
 */
export async function getProduct(id: string): Promise<ProductDto | null> {
  try {
    const { data } = await http.get<ProductDto>(`/products/${encodeURIComponent(id)}`);
    return data;
  } catch (err) {
    if (err instanceof AxiosError && (err.response?.status === 404 || err.response?.status === 400)) return null;
    const why = err instanceof AxiosError ? (err.response ? `HTTP ${err.response.status}` : `${err.code}: ${err.message}`) : String(err);
    console.error(`[product-client] lookup failed for ${id}: ${why}`);
    throw new HttpError(503, 'Product service unavailable, order was not placed. Please retry.');
  }
}
