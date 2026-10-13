// The relay's state (design §4.3, Q5): the fixes several machines' memories
// share - cloud agents' containers, teammates' laptops - kept by the error's
// fingerprint, each with the sequence number it last changed at, so a machine
// asks for what changed since it last looked.
//
// The relay holds only what export lets leave a machine: entries with a
// working fix, redacted again, without notes or review marks. It speaks
// documents in the export's format, so what a machine pulls is read the way
// `antibody import` reads a committed file, with the same limits, and is held
// for review there unless the machine trusts the relay (src/relay-client.ts).
//
// Pure: src/relay-server.ts serves it over HTTP and saves it to a file.
import { exportable, forExport, IMPORT_MAX_BYTES } from "./exchange";
import { oneLine } from "./notice";
import {
  DOCUMENT_HEADER,
  ParseError,
  parseDocument,
  renderEntry,
} from "./store";
import type { Entry } from "./store";

/** The version every saved relay state carries. */
export const RELAY_VERSION = 1;

/** The most fixes a relay keeps; a new fingerprint past this is refused. */
export const RELAY_MAX_FIXES = 5000;

/** The largest document a machine may push. */
export const RELAY_MAX_BYTES = IMPORT_MAX_BYTES;

/** What a relay's documents say about themselves, below their title. */
export const RELAY_PREAMBLE = [
  "Fixes shared through an antibody relay.",
  "A machine that pulls them holds them for review unless it trusts the relay.",
  "",
].join("\n");

const FINGERPRINT = /^[0-9a-f]{12}$/;

/** One fix the relay holds, and the sequence number it last changed at. */
export interface RelayFix {
  seq: number;
  entry: Entry;
}

/** A fix the owner removed, and the sequence number the removal happened at. */
export interface RelayRemoval {
  seq: number;
  /** The fingerprint the fix was held under. */
  key: string;
}

/** Everything a relay holds. */
export interface RelayState {
  version: typeof RELAY_VERSION;
  /** The last sequence number given out; 0 before the first fix. */
  seq: number;
  fixes: RelayFix[];
  /** Fixes the owner removed, in the order they were removed. */
  removed: RelayRemoval[];
  /**
   * Fingerprints the owner removed: a push of one is ignored, so a removed fix
   * does not come back from a machine that still has it.
   */
  blocked: string[];
}

/** A relay with nothing yet. */
export function emptyRelay(): RelayState {
  return {
    version: RELAY_VERSION,
    seq: 0,
    fixes: [],
    removed: [],
    blocked: [],
  };
}

const keyOf = (entry: Entry) => entry.meta.sig ?? entry.fingerprint;

/**
 * Read a saved relay state.
 *
 * @param text - the file's contents.
 * @returns the state, or undefined when the text is not one.
 */
export function parseRelayState(text: string): RelayState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== RELAY_VERSION ||
    !Number.isInteger(raw.seq) ||
    !Array.isArray(raw.fixes)
  )
    return undefined;
  const fixes: RelayFix[] = [];
  for (const fix of raw.fixes as unknown[]) {
    const f = fix as Partial<RelayFix> | null;
    if (
      typeof f?.seq !== "number" ||
      typeof f.entry !== "object" ||
      f.entry === null ||
      typeof f.entry.fix !== "string" ||
      typeof f.entry.meta !== "object" ||
      f.entry.meta === null
    )
      return undefined;
    fixes.push({ seq: f.seq, entry: f.entry });
  }
  // Files saved before removals existed have neither list: they start empty.
  const removed: RelayRemoval[] = [];
  for (const r of (raw.removed ?? []) as unknown[]) {
    const item = r as Partial<RelayRemoval> | null;
    if (
      typeof item?.seq !== "number" ||
      typeof item.key !== "string" ||
      !FINGERPRINT.test(item.key)
    )
      return undefined;
    removed.push({ seq: item.seq, key: item.key });
  }
  const blocked = (raw.blocked ?? []) as unknown[];
  if (!blocked.every((k) => typeof k === "string" && FINGERPRINT.test(k)))
    return undefined;
  return {
    version: RELAY_VERSION,
    seq: raw.seq as number,
    fixes,
    removed,
    blocked: blocked as string[],
  };
}

/** What taking in a pushed document came to. */
export interface Accepted {
  state: RelayState;
  /** Fixes that were new, or changed. */
  accepted: number;
  /** Fixes left out: no working fix, a bad fingerprint, or no room. */
  ignored: number;
}

/**
 * Take in the fixes of a document a machine pushed. A fix for a fingerprint
 * the relay holds replaces it only when its text changed; either way the
 * relay redacts it again, as export did.
 *
 * @param state - the relay's state; not changed.
 * @param text - the pushed document, in the export's format.
 * @returns the new state and the counts, or why the document was refused.
 */
export function acceptFixes(
  state: RelayState,
  text: string,
): Accepted | { error: string } {
  if (Buffer.byteLength(text) > RELAY_MAX_BYTES)
    return { error: `a document over ${RELAY_MAX_BYTES / 1024} KiB` };
  let entries: Entry[];
  try {
    entries = parseDocument(text).blocks.map((b) => b.entry);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    return { error: `a document that does not parse: ${error.message}` };
  }
  const next: RelayState = { ...state, fixes: [...state.fixes] };
  const at = new Map(next.fixes.map((f, i) => [keyOf(f.entry), i]));
  const blocked = new Set(state.blocked);
  let accepted = 0;
  let ignored = 0;
  for (const incoming of entries) {
    const key = keyOf(incoming);
    if (!exportable(incoming) || !FINGERPRINT.test(key) || blocked.has(key)) {
      ignored++;
      continue;
    }
    const entry = forExport(incoming);
    const i = at.get(key);
    if (i !== undefined) {
      const held = next.fixes[i] as RelayFix;
      if (oneLine(held.entry.fix) === oneLine(entry.fix)) continue;
      next.fixes[i] = { seq: ++next.seq, entry };
    } else if (next.fixes.length >= RELAY_MAX_FIXES) {
      ignored++;
      continue;
    } else {
      at.set(key, next.fixes.length);
      next.fixes.push({ seq: ++next.seq, entry });
    }
    accepted++;
  }
  return { state: next, accepted, ignored };
}

/**
 * Remove the fix held under `key`, and block the key so a push of it is
 * ignored from now on. A key the relay does not hold is still blocked.
 *
 * @param state - the relay's state; not changed.
 * @param key - the fingerprint, twelve lowercase hex digits.
 * @returns the new state, and whether a fix was removed.
 */
export function removeFix(
  state: RelayState,
  key: string,
): { state: RelayState; removed: boolean } {
  const blocked = state.blocked.includes(key)
    ? state.blocked
    : [...state.blocked, key];
  const i = state.fixes.findIndex((f) => keyOf(f.entry) === key);
  if (i < 0) return { state: { ...state, blocked }, removed: false };
  const seq = state.seq + 1;
  return {
    state: {
      ...state,
      seq,
      fixes: state.fixes.filter((_, j) => j !== i),
      removed: [...state.removed, { seq, key }],
      blocked,
    },
    removed: true,
  };
}

/** What a machine is sent when it asks what changed. */
export interface Since {
  /** The relay's latest sequence number, to ask from next time. */
  seq: number;
  /** The changed fixes as a document; "" when nothing changed. */
  text: string;
  count: number;
  /** The fingerprints removed after `since`, oldest removal first. */
  removed: string[];
}

/**
 * The fixes that changed after `since`, oldest change first, as a document in
 * the export's format. Entries are numbered afresh, since machines' own IDs
 * collide; an importing machine gives them IDs of its own anyway.
 *
 * @param state - the relay's state.
 * @param since - the sequence number the machine last saw.
 */
export function fixesSince(state: RelayState, since: number): Since {
  const removed = state.removed
    .filter((r) => r.seq > since)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => r.key);
  const changed = state.fixes
    .filter((f) => f.seq > since)
    .sort((a, b) => a.seq - b.seq);
  if (changed.length === 0)
    return { seq: state.seq, text: "", count: 0, removed };
  const blocks = changed
    .map((f, i) =>
      renderEntry({ ...f.entry, id: `E-${String(i + 1).padStart(4, "0")}` }),
    )
    .join("\n");
  return {
    seq: state.seq,
    text: `${DOCUMENT_HEADER}\n${RELAY_PREAMBLE}\n${blocks}`,
    count: changed.length,
    removed,
  };
}
