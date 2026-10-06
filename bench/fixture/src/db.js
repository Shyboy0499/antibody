// The shop's data, shaped by the generated client.
import { config } from "./config.js";

// Loaded once the configuration is known, as an ORM's client would be.
const { columns } = await import("../generated/client.js");

const rows = {
  products: [
    { id: 1, name: "Mug", priceCents: 1200 },
    { id: 2, name: "Poster", priceCents: 2500 },
    { id: 3, name: "Sticker", priceCents: 300 },
  ],
};

export const database = config.databaseUrl;

export function find(table, id) {
  const known = columns(table);
  const row = (rows[table] ?? []).find((r) => r.id === id);
  if (row === undefined) return undefined;
  return Object.fromEntries(known.map((c) => [c, row[c]]));
}
