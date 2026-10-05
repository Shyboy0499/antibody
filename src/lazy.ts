// Built-in modules that cost start-up time, loaded on first use.
//
// A hook starts a new process on every tool call. node:crypto and
// node:child_process each add about 10 ms to a cold start, and most hook calls
// need neither: crypto only when an error is fingerprinted or a fix hashed,
// child_process only when antibody falls back to running git. readline, which
// brings the whole streams stack with it, only serves `antibody mcp`.
// process.getBuiltinModule (Node 22.3 and later) loads them synchronously, on
// demand.

/** node:crypto, loaded on first use. */
export const lazyCrypto = (): typeof import("node:crypto") =>
  process.getBuiltinModule("node:crypto");

/** node:child_process, loaded on first use. */
export const lazyChildProcess = (): typeof import("node:child_process") =>
  process.getBuiltinModule("node:child_process");

/** node:readline, loaded on first use. */
export const lazyReadline = (): typeof import("node:readline") =>
  process.getBuiltinModule("node:readline");
