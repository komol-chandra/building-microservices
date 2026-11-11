import axios, { AxiosError } from 'axios';

/**
 * The ONLY backend the browser knows is the gateway. It never sees
 * product-service or order-service: those have no public ports.
 *
 * The URL is the HOST address (localhost:8081), not the Docker DNS name
 * (api-gateway:8081): this code runs in the browser, outside the Docker network.
 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:8081',
  timeout: 10_000,
});

// ---------------- token storage ----------------
export type Role = 'user' | 'admin';
export interface User {
  sub: string;
  email: string;
  name: string;
  role: Role;
}
interface Session {
  token: string;
  user: User;
}

const SESSION_KEY = 'ms.session';

export function loadSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
}
export function saveSession(s: Session | null) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

// Attach the JWT to every request. The gateway verifies it and turns it into x-user-* headers.
api.interceptors.request.use((config) => {
  const s = loadSession();
  if (s) config.headers.Authorization = `Bearer ${s.token}`;
  return config;
});

// Token expired or invalid → drop it and go to login (but not for a failed login/register itself).
// A 503 ("can't verify tokens right now") is NOT a reason to log out: the token may be fine.
api.interceptors.response.use(undefined, (err: AxiosError) => {
  const url = err.config?.url ?? '';
  if (err.response?.status === 401 && !url.startsWith('/auth/login') && !url.startsWith('/auth/register')) {
    saveSession(null);
    window.location.assign('/login');
  }
  return Promise.reject(err);
});

/** Turns any API error into one readable line. Every service uses {error, message, details}. */
export function errorMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    const body = err.response?.data as { message?: string; details?: unknown } | undefined;
    if (!err.response) return 'Gateway unreachable (network error or timeout)';
    let msg = body?.message ?? `HTTP ${err.response.status}`;
    if (Array.isArray(body?.details)) {
      msg += ': ' + body.details.map((d: { path?: string; message?: string }) => `${d.path} ${d.message}`).join(', ');
    }
    return msg;
  }
  return String(err);
}

// ---------------- DTOs (as the services return them) ----------------
// Prisma serializes Decimal as a string ("18" or "18.5"), so money is a string here.
export type ProductStatus = 'DRAFT' | 'PUBLISHED' | 'UNLISTED';
export interface Stock {
  inventoryId: string;
  available: number;
  reserved: number;
}
export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  price: string;
  status: ProductStatus;
  inventoryId: string | null;
  createdAt: string;
  stock?: Stock | null; // only on GET /products/:id; null = inventory-service was down
}

export interface StockHistory {
  id: string;
  actionType: 'IN' | 'OUT' | 'RESERVE' | 'RELEASE';
  quantityChanged: number;
  lastQuantity: number;
  currentQuantity: number;
  reason: string | null;
  orderId: string | null;
  createdAt: string;
}

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
export interface LineItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  price: string;
  quantity: number;
  total: string;
}
export interface Order {
  id: string;
  status: OrderStatus;
  failureReason: string | null;
  subtotal: string;
  discount: string;
  tax: string;
  grandTotal: string;
  createdAt: string;
  updatedAt: string;
  items: LineItem[];
}

export interface Page<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/** Display only. Totals are computed by order-service with Decimal, never here. */
export const money = (v: string | number) => Number(v).toFixed(2);
