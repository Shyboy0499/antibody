// Ported from dsh-errkb, src/paths.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Only the file layout comes over: the file names, the paths built
// from a directory, and the name for a copy of an unparseable document.
// dsh-errkb's directory tiers locate a DeepSeek Harness home; antibody finds its
// memory directory through the git common directory instead, which is added
// separately.
import { join } from "node:path";

/** The six file names the knowledge base directory holds. */
export const KB_FILE = {
  errors: "ERRORS.md",
  archive: "ERRORS.archive.md",
  index: "errors.index.json",
  state: "state.json",
  machine: ".machine.json",
  lock: ".lock",
} as const;

/** Absolute paths of the six files inside one knowledge base directory. */
export interface KbFiles {
  errors: string;
  archive: string;
  index: string;
  state: string;
  machine: string;
  lock: string;
}

/**
 * Build the six absolute file paths inside a knowledge base directory.
 *
 * @param dir - the resolved knowledge base directory.
 * @returns the file paths.
 */
export function filesIn(dir: string): KbFiles {
  return {
    errors: join(dir, KB_FILE.errors),
    archive: join(dir, KB_FILE.archive),
    index: join(dir, KB_FILE.index),
    state: join(dir, KB_FILE.state),
    machine: join(dir, KB_FILE.machine),
    lock: join(dir, KB_FILE.lock),
  };
}

/**
 * Name for the copy of a document that could not be parsed.
 *
 * Colons and dots are replaced so the name is legal on Windows, and the whole
 * stamp is derived from the argument so the caller can pin it in a test.
 *
 * @param now - timestamp to embed; defaults to the current time.
 * @returns a file name, never a path.
 */
export function corruptFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `ERRORS.corrupt-${stamp}.md`;
}
