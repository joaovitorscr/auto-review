export type Item = { price: number; quantity: number };

const toCents = (dollars: number) => Math.round(dollars * 100);

/** Returns the cart total in cents. */
export function totalCents(items: Item[]): number {
  return items.reduce((sum, item) => sum + toCents(item.price) * item.quantity, 0);
}
