// Money, kept in integer cents.
import { config } from "./config.js";

/** Cents as a plain decimal string: 1200 -> "12.00". */
export function toDecimal(cents) {
  return (cents / 100).toFixed(2);
}

export const defaultCurrency = config.currency;

const SYMBOLS = { USD: "$", EUR: "€", GBP: "£" };

/** Cents as a price: 1200, "USD" -> "$12.00". */
export function formatPrice(cents, currency = defaultCurrency) {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const sign = cents < 0 ? "-" : "";
  return `${sign}${symbol}${toDecimal(Math.abs(cents))}`;
}
