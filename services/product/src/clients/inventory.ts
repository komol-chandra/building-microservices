import axios, { AxiosError } from 'axios';
import { log, requestId } from '../context';

/**
 * HTTP client for inventory-service.
 *
 * Service-to-service calls go DIRECTLY over the Docker network
 * (http://inventory-service:4002), never through the public gateway.
 *
 * Every call has a TIMEOUT. Without one, a hung inventory-service would make
 * product-service hang too, and its requests would pile up: one slow service
 * takes down the services that call it ("cascading failure").
 */
const http = axios.create({
  baseURL: process.env.INVENTORY_SERVICE_URL ?? 'http://inventory-service:4002',
  timeout: Number(process.env.INVENTORY_TIMEOUT_MS ?? 2000),
});

// Pass the correlation id on, so inventory's log lines carry the same id as ours.
http.interceptors.request.use((config) => {
  const id = requestId();
  if (id) config.headers['x-request-id'] = id;
  return config;
});

export interface InventoryDto {
  id: string;
  productId: string;
  availableQuantity: number;
  reservedQuantity: number;
}

export interface Stock {
  inventoryId: string;
  available: number;
  reserved: number;
}

const toStock = (i: InventoryDto): Stock => ({
  inventoryId: i.id,
  available: i.availableQuantity,
  reserved: i.reservedQuantity,
});

function describe(err: unknown): string {
  if (err instanceof AxiosError) {
    return err.response ? `HTTP ${err.response.status}` : `${err.code ?? 'network error'}: ${err.message}`;
  }
  return String(err);
}

/** Write path: the caller must know if this failed, so it THROWS. */
export async function createInventory(productId: string, quantity: number): Promise<Stock> {
  const { data } = await http.post<InventoryDto>('/inventories', { productId, quantity });
  return toStock(data);
}

/**
 * Read path: if inventory is down we still want to show the product,
 * so this NEVER throws. It returns null ("stock unknown") instead.
 * This is graceful degradation.
 */
export async function getStockByProductId(productId: string): Promise<Stock | null> {
  try {
    const { data } = await http.get<InventoryDto>(`/inventories/product/${encodeURIComponent(productId)}`);
    return toStock(data);
  } catch (err) {
    log.warn(`[inventory-client] stock lookup failed for ${productId}: ${describe(err)}`);
    return null;
  }
}

export { describe as describeInventoryError };
