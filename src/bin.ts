#!/usr/bin/env node
// The `antibody` executable: wires main() to the real process.
import { main } from "./cli";

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

process.exitCode = await main(process.argv.slice(2), {
  readStdin,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
});
