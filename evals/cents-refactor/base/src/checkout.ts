import { totalCents } from "./cart";

export function chargeRequest(items: { price: number; quantity: number }[]) {
  // The payment API expects an integer amount in cents.
  return { amount: totalCents(items), currency: "usd" };
}
