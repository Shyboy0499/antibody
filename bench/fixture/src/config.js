// Settings, read from the environment and from .env in the project root.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile))
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null && process.env[match[1]] === undefined)
      process.env[match[1]] = match[2];
  }

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`Environment variable not found: ${name}.`);
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  port: Number(process.env.PORT ?? 4817),
  currency: process.env.CURRENCY ?? "USD",
};
