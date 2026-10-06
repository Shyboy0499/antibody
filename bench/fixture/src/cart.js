// Carts: lines of a product and a quantity.
import { find } from "./db.js";

export function lineTotal(line) {
  const product = find("products", line.productId);
  if (product === undefined) throw new Error(`no product ${line.productId}`);
  return product.priceCents;
}

/** The cart's total in cents. */
export function cartTotal(lines) {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}
