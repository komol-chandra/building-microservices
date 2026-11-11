import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Product } from './api';

/**
 * Client-only cart (there is no Cart service yet, that's a Phase 8 stretch).
 * We keep name/price only to DISPLAY the cart. On checkout we send just
 * {productId, quantity}: order-service fetches the real price itself.
 */
export interface CartItem {
  productId: string;
  name: string;
  price: string;
  quantity: number;
}

interface CartState {
  items: CartItem[];
  add: (p: Product, quantity: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  clear: () => void;
}

const CART_KEY = 'ms.cart';
const CartContext = createContext<CartState | null>(null);

function load(): CartItem[] {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>(load);
  useEffect(() => localStorage.setItem(CART_KEY, JSON.stringify(items)), [items]);

  const add = (p: Product, quantity: number) =>
    setItems((prev) => {
      const found = prev.find((i) => i.productId === p.id);
      if (found) return prev.map((i) => (i === found ? { ...i, quantity: i.quantity + quantity } : i));
      return [...prev, { productId: p.id, name: p.name, price: p.price, quantity }];
    });

  const setQuantity = (productId: string, quantity: number) =>
    setItems((prev) =>
      quantity <= 0 ? prev.filter((i) => i.productId !== productId) : prev.map((i) => (i.productId === productId ? { ...i, quantity } : i)),
    );

  return <CartContext.Provider value={{ items, add, setQuantity, clear: () => setItems([]) }}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart outside CartProvider');
  return ctx;
}
