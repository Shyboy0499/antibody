// Carts: lines of a product and a quantity.
import { find } from "./db.js";

export function lineTotal(line) {
  const product = find("products", line.productId);
  if (product === undefined) throw new Error(`no product ${line.productId}`);
  return product.priceCents;
}

const DISCOUNTS = { SAVE10: 0.1 };

/** The cart's total in cents, less a discount code's share. */
export function cartTotal(lines, code) {
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  if (code === undefined) return total;
  const off = DISCOUNTS[code];
  if (off === undefined) throw new Error(`unknown discount code: ${code}`);
  return Math.floor(total * (1 - off));
}
