// Lists of products and orders.
import { config } from "./config.js";

export const defaultPageSize = config.pageSize ?? 20;

export function sortBy(items, key) {
  return [...items].sort((a, b) =>
    a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0,
  );
}
