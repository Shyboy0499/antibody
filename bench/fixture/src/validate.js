// Checks on what customers type.
import { config } from "./config.js";

export const strict = config.strict ?? false;

/** Whether a string looks like an e-mail address. */
export function isEmail(text) {
  return /^[^\s@]+@[^\s@]+$/.test(text);
}
