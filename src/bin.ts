#!/usr/bin/env node
// The `antibody` executable: wires main() to the real process.
//
// A hook starts a new process on every tool call, so start-up time counts.
// process.stdin and process.stdout are streams: touching either one loads the
// streams stack, and node:net when they are pipes, about 10 ms before antibody
// does anything. So stdin is read and stdout written through their file
// descriptors. Only `antibody mcp`, which reads stdin line by line for as long
// as it runs, uses the stdin stream.
import { fstatSync, readFileSync, writeSync } from "node:fs";
import { main } from "./cli";

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** All of stdin as text; nothing when it is a terminal. */
async function readStdin(): Promise<string> {
  // A terminal is a character device; so is /dev/null, which reads as "".
  if (fstatSync(0).isCharacterDevice()) return "";
  try {
    return readFileSync(0, "utf8");
  } catch (error) {
    // A non-blocking pipe cannot be read synchronously: fall back to the stream.
    if (errorCode(error) !== "EAGAIN") throw error;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
}

/**
 * A writer for a file descriptor. A full non-blocking pipe is retried; a
 * reader that went away, such as an MCP client that closed its end, ends the
 * process quietly instead of with a stack trace.
 */
const writer =
  (fd: number) =>
  (text: string): void => {
    const buffer = Buffer.from(text, "utf8");
    let written = 0;
    while (written < buffer.length) {
      try {
        written += writeSync(fd, buffer, written);
      } catch (error) {
        if (errorCode(error) === "EAGAIN") continue;
        if (errorCode(error) === "EPIPE") process.exit(0);
        throw error;
      }
    }
  };

process.exitCode = await main(process.argv.slice(2), {
  readStdin,
  stdout: writer(1),
  stderr: writer(2),
  env: process.env,
});
