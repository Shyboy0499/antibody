// Built-in modules that cost start-up time, loaded on first use.
//
// A hook starts a new process on every tool call, and most calls need neither
// of these: node:child_process (about 10 ms) only when antibody falls back to
// running git, and node:readline, which brings the whole streams stack with
// it, only for `antibody mcp`. process.getBuiltinModule (Node 22.3 and later)
// loads them synchronously, on demand. node:crypto is not needed at all:
// src/sha256.ts hashes in plain JavaScript.

/** node:child_process, loaded on first use. */
export const lazyChildProcess = (): typeof import("node:child_process") =>
  process.getBuiltinModule("node:child_process");

/** node:readline, loaded on first use. */
export const lazyReadline = (): typeof import("node:readline") =>
  process.getBuiltinModule("node:readline");

/**
 * node:fs itself, not its ES module wrapper. An `import … from "node:fs"`
 * builds the named exports by reading every property of the module, and that
 * runs the lazy getters behind fs.promises, the stream classes, Dir and the
 * watchers: about thirty internal modules, the streams stack among them,
 * before the hook does anything. process.getBuiltinModule() returns the module
 * without touching them, and node:fs itself is loaded at start-up anyway.
 */
export const nodeFs: typeof import("node:fs") =
  process.getBuiltinModule("node:fs");
