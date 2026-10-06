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
import { clip, oneLine } from "./notice";
import { redact, redactSample } from "./redact";
import {
  HOLD_FIX,
  REVIEW_ALL,
  REVIEW_KEY,
  heldParts,
  pendingReview,
} from "./review";
import { DOCUMENT_HEADER, renderEntry } from "./store";
import type { Entry, NewEntry } from "./store";

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

// ---------------------------------------------------------------------------
// Import
//
// The file is someone else's text, so it is read with suspicion: a size limit,
// a fingerprint that looks like one, text cut to a length a fix and its
// context need and stripped of control characters, and no more entries than
// the memory has room for - an import must not push this machine's own
// entries out into the archive.

/** A file larger than this is refused. */
export const IMPORT_MAX_BYTES = 512 * 1024;

/** The longest each imported text is kept, in code points. */
export const IMPORT_MAX_CHARS = {
  title: 200,
  category: 80,
  trigger: 200,
  meta: 80,
  fix: 1000,
} as const;

// The machine fields an imported entry keeps; `sig` is its identity and the
// rest decide how errors match it. Anything else, `misjudged` and `review`
// included, is the file's to say, not ours to believe.
const IMPORT_META = ["cat", "code", "proj", "first"] as const;

// What a fingerprint looks like: signature() gives twelve lowercase hex digits.
const FINGERPRINT = /^[0-9a-f]{12}$/;

const UNSEEN =
  // oxlint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/**
 * Text with what a terminal could act on, and what a reader cannot see, taken
 * out: control characters, zero-width and direction-changing characters, and
 * the invisible "tag" characters that can hide a whole sentence from a person
 * who reads the text and not from a model.
 */
export function plain(text: string): string {
  return text.replace(UNSEEN, "");
}

const line = (text: string, max: number) => clip(oneLine(plain(text)), max);

/** The key an entry is known by: the fingerprint matching uses. */
const keyOf = (entry: Entry) => entry.meta.sig ?? entry.fingerprint;

/**
 * An incoming entry as a new local entry: its texts cut and cleaned, its
 * machine fields cut down to the ones that matter, and the whole of it held
 * for review.
 *
 * @param entry - an entry of the file being imported, with a working fix.
 * @param source - where it came from, noted on the entry.
 */
export function forImport(entry: Entry, source: string): NewEntry {
  const meta: Record<string, string> = { [REVIEW_KEY]: REVIEW_ALL };
  for (const key of IMPORT_META) {
    const value = entry.meta[key];
    if (value !== undefined) meta[key] = line(value, IMPORT_MAX_CHARS.meta);
  }
  return {
    title: line(entry.title, IMPORT_MAX_CHARS.title),
    signature: keyOf(entry),
    category: line(entry.category, IMPORT_MAX_CHARS.category),
    meta,
    trigger: line(entry.trigger, IMPORT_MAX_CHARS.trigger),
    raw: plain(entry.raw),
    fix: clip(plain(entry.fix).trim(), IMPORT_MAX_CHARS.fix),
    status: "fixed",
    notes: `Imported from ${source}.`,
  };
}

/** Why an incoming entry was left out. */
export type Skipped =
  "no-fix" | "duplicate" | "bad-fingerprint" | "wontfix" | "full";

/** What `antibody import` will do. */
export interface ImportPlan {
  /** New entries, for errors this machine has not met. */
  add: NewEntry[];
  /** Fixes for entries this machine has, and has no fix for. */
  adopt: { id: string; fix: string }[];
  /** Incoming entries this machine already has a fix for. */
  known: number;
  skipped: Record<Skipped, number>;
}

/**
 * Decide what to do with each incoming entry. An entry already here keeps its
 * own fix, so importing twice, or in the clone that exported, changes nothing.
 *
 * @param local - the memory's entries.
 * @param incoming - the entries of the file.
 * @param room - how many new entries the memory has room for.
 * @param source - the file's name, noted on new entries.
 */
export function planImport(
  local: readonly Entry[],
  incoming: readonly Entry[],
  room: number,
  source: string,
): ImportPlan {
  const plan: ImportPlan = {
    add: [],
    adopt: [],
    known: 0,
    skipped: {
      "no-fix": 0,
      duplicate: 0,
      "bad-fingerprint": 0,
      wontfix: 0,
      full: 0,
    },
  };
  const here = new Map(local.map((e) => [keyOf(e), e]));
  const seen = new Set<string>();
  for (const entry of incoming) {
    const key = keyOf(entry);
    if (entry.status !== "fixed" || oneLine(entry.fix) === "") {
      plan.skipped["no-fix"]++;
    } else if (!FINGERPRINT.test(key)) {
      plan.skipped["bad-fingerprint"]++;
    } else if (seen.has(key)) {
      plan.skipped.duplicate++;
    } else {
      seen.add(key);
      const mine = here.get(key);
      if (mine === undefined) {
        if (plan.add.length < room) plan.add.push(forImport(entry, source));
        else plan.skipped.full++;
      } else if (mine.status === "wontfix") plan.skipped.wontfix++;
      else if (oneLine(mine.fix) !== "") plan.known++;
      else
        plan.adopt.push({
          id: mine.id,
          fix: clip(plain(entry.fix).trim(), IMPORT_MAX_CHARS.fix),
        });
    }
  }
  return plan;
}

/** The change to an entry's machine fields when it is given an imported fix. */
export function holdImportedFix(
  meta: Readonly<Record<string, string>>,
): Record<string, string> {
  return { [REVIEW_KEY]: heldParts(meta).text ? REVIEW_ALL : HOLD_FIX };
}
