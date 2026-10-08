import { paginate } from "./paginate";

const PAGE_SIZE = 20;

export function listOrders(orders: string[], query: { page?: string }) {
  // Clients request pages starting at 0.
  const page = Number(query.page ?? "0");
  return { page, orders: paginate(orders, page, PAGE_SIZE) };
}
