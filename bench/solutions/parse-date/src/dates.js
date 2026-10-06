// Dates in orders, as YYYY-MM-DD strings.
import { config } from "./config.js";

export const timeZone = config.timeZone ?? "UTC";

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** A YYYY-MM-DD string as a Date at midnight UTC, or null if it is no real date. */
export function parseDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== text
    ? null
    : date;
}
