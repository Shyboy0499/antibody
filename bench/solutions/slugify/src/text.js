// Text helpers for product pages.
import { config } from "./config.js";

export function titleCase(text) {
  return text
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toLocaleUpperCase(config.locale));
}

/** A URL slug for a title: "Café Crème — Large!" -> "cafe-creme-large". */
export function slugify(title) {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
