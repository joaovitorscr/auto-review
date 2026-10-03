/** Returns one page of items. `page` is zero-based. */
export function paginate<T>(items: T[], page: number, size: number): T[] {
  const start = page * size;
  return items.slice(start, start + size);
}
