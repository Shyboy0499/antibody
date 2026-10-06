// What the commands that work on the memory share: opening it, and naming a
// file the way a person typed it.
import { isAbsolute, relative } from "node:path";
import type { CliIo, McpDeps } from "./cli";
import { filesIn, memoryDir } from "./paths";
import { createStore } from "./store";
import type { Entry, ErrorStore } from "./store";

/**
 * The memory's store and its entries as the document holds them, or the
 * reason they cannot be read: outside a repository, or a document that does
 * not parse.
 */
export async function openMemory(
  cwd: string,
  io: CliIo,
  deps: McpDeps,
): Promise<{ store: ErrorStore; entries: Entry[] } | { error: string }> {
  let memory: string;
  try {
    memory = memoryDir(cwd, deps.git, io.env);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const store = createStore(filesIn(memory));
  try {
    const document = await store.read();
    return { store, entries: document.blocks.map((b) => b.entry) };
  } catch (error) {
    return {
      error: `could not read ANTIBODIES.md: ${(error as Error).message}`,
    };
  }
}

/** A path as a person would type it: relative to `cwd` when it is below it. */
export function shown(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}
