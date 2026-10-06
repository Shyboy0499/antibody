// Lists of products and orders.
import { config } from "./config.js";

export const defaultPageSize = config.pageSize ?? 20;

export function sortBy(items, key) {
  return [...items].sort((a, b) =>
    a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0,
  );
}

/** One page of a list, counting pages from 1. */
export function paginate(items, page, size = defaultPageSize) {
  const start = (page - 1) * size;
  return {
    items: items.slice(start, start + size),
    page,
    pages: Math.max(1, Math.ceil(items.length / size)),
    total: items.length,
  };
}
