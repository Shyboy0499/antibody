// Sharing fixes between clones (design §4.3).
//
// The memory lives inside .git, so a teammate's clone, or a cloud agent's,
// starts without it. `antibody export` writes the fixes this fleet found to
// ANTIBODIES.md in the worktree root, to be committed with the code; a fresh
// clone reads that file with `antibody import`, and the fixes wait there for a
// person (src/review.ts) before any agent sees them.
//
// This file is the pure part: which entries leave the machine, and what the
// exported document looks like. What leaves is only what a person could
// publish: fixes that were found here and not merely imported, redacted
// again - the file may have been edited by hand since the store redacted it -
// without the notes, which are the people's own, and without the review mark.
import { oneLine } from "./notice";
import { redact, redactSample } from "./redact";
import { REVIEW_KEY, pendingReview } from "./review";
import { DOCUMENT_HEADER, renderEntry } from "./store";
import type { Entry } from "./store";

/** The exported file's name, in the worktree root. */
export const EXCHANGE_FILE = "ANTIBODIES.md";

/** What the exported file says about itself, below its title. */
export const EXCHANGE_PREAMBLE = [
  "Fixes this repository's coding agents found, exported by `antibody export`.",
  "`antibody import` reads them into a clone's memory, where they wait until a",
  "person approves them with `antibody allow`.",
  "",
].join("\n");

// The machine field that is the entry's identity: left as it is.
const SIG = "sig";

/**
 * Whether an entry leaves the machine: it has a fix, the fix is marked
 * working, and it was not imported and left waiting for review.
 */
export function exportable(entry: Entry): boolean {
  return (
    entry.status === "fixed" &&
    oneLine(entry.fix) !== "" &&
    !pendingReview(entry)
  );
}

/** An entry as it is exported: redacted again, without what is local. */
export function forExport(entry: Entry): Entry {
  const clean = (text: string) => redact(text, { share: "public" });
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.meta))
    if (key !== REVIEW_KEY) meta[key] = key === SIG ? value : clean(value);
  return {
    ...entry,
    title: clean(entry.title),
    category: clean(entry.category),
    meta,
    trigger: clean(entry.trigger),
    raw: redactSample(entry.raw, { share: "public" }),
    fix: clean(entry.fix),
    notes: "",
  };
}

/** What `antibody export` writes. */
export interface Exported {
  /** The document; "" when no entry is exportable. */
  text: string;
  /** How many entries it holds. */
  exported: number;
}

/**
 * The document `antibody export` writes: the exportable entries, in the order
 * they have in the memory, so exporting again changes only what changed.
 *
 * @param entries - the memory's entries.
 */
export function exportDocument(entries: readonly Entry[]): Exported {
  const chosen = entries.filter(exportable).map(forExport);
  if (chosen.length === 0) return { text: "", exported: 0 };
  const blocks = chosen.map((entry) => renderEntry(entry)).join("\n");
  return {
    text: `${DOCUMENT_HEADER}\n${EXCHANGE_PREAMBLE}\n${blocks}`,
    exported: chosen.length,
  };
}
