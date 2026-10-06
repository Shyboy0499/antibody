// Dates in orders, as YYYY-MM-DD strings.
import { config } from "./config.js";

export const timeZone = config.timeZone ?? "UTC";

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
