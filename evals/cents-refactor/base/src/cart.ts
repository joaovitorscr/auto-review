export type Item = { price: number; quantity: number };

/** Returns the cart total in cents. */
export function totalCents(items: Item[]): number {
  let total = 0;
  for (const item of items) {
    total += Math.round(item.price * 100) * item.quantity;
  }
  return total;
}
