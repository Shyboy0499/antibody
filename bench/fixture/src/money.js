// Money, kept in integer cents.
import { config } from "./config.js";

/** Cents as a plain decimal string: 1200 -> "12.00". */
export function toDecimal(cents) {
  return (cents / 100).toFixed(2);
}

export const defaultCurrency = config.currency;
