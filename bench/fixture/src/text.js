// Text helpers for product pages.
import { config } from "./config.js";

export function titleCase(text) {
  return text
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toLocaleUpperCase(config.locale));
}
