// The relay's state: what it takes in from a pushed document, what it sends a
// machine that asks what changed, and how it is saved.
import { describe, expect, it } from "vitest";
import {
  acceptFixes,
  emptyRelay,
  fixesSince,
  parseRelayState,
  RELAY_MAX_BYTES,
  RELAY_MAX_FIXES,
  RELAY_PREAMBLE,
} from "../src/relay";
import type { RelayState } from "../src/relay";
import { DOCUMENT_HEADER, parseDocument, renderEntry } from "../src/store";
import type { Entry } from "../src/store";

// Built in two parts so this file holds no credential-shaped literal.
const SECRET = ["ghp_", "Zq7Xw2Lp9Rt4Vb8Nm3Kd6Hs1"].join("");

const entry = (
  n: number,
  extra: Partial<Entry> = {},
  meta: Record<string, string> = {},
): Entry => ({
  id: `E-000${n}`,
  title: `[tool:Bash] failure number ${n}`,
  meta: { sig: `00000000000${n}`, cat: "tool", ...meta },
  fingerprint: `00000000000${n}`,
  category: "tool / Bash",
  firstSeen: "2026-10-05 09:00",
  lastSeen: "2026-10-05 10:00",
  hits: 3,
  trigger: "pnpm test",
  raw: `failure number ${n}`,
  fix: `Fix number ${n}.`,
  status: "fixed",
  notes: "",
  ...extra,
});

const doc = (...entries: Entry[]) =>
  `${DOCUMENT_HEADER}\n${entries.map((e) => renderEntry(e)).join("\n")}`;

const accept = (state: RelayState, text: string) => {
  const result = acceptFixes(state, text);
  if ("error" in result) throw new Error(result.error);
  return result;
};

describe("acceptFixes", () => {
  it("takes the working fixes of a document, each with a sequence number", () => {
    const { state, accepted, ignored } = accept(
      emptyRelay(),
      doc(entry(1), entry(2)),
    );
    expect([accepted, ignored, state.seq]).toEqual([2, 0, 2]);
    expect(state.fixes.map((f) => [f.seq, f.entry.fix])).toEqual([
      [1, "Fix number 1."],
      [2, "Fix number 2."],
    ]);
  });

  it("leaves out what export would not let leave a machine, and bad fingerprints", () => {
    const { state, accepted, ignored } = accept(
      emptyRelay(),
      doc(
        entry(1, { fix: "" }),
        entry(2, { status: "wontfix" }),
        entry(3, {}, { review: "fix+text" }),
        entry(4, {}, { sig: "not-a-print" }),
        entry(5),
      ),
    );
    expect([accepted, ignored]).toEqual([1, 4]);
    expect(state.fixes.map((f) => f.entry.meta.sig)).toEqual(["000000000005"]);
  });

  it("redacts every fix again, and keeps no notes", () => {
    const { state } = accept(
      emptyRelay(),
      doc(entry(1, { fix: `export GH=${SECRET}`, notes: "mine" })),
    );
    const held = state.fixes[0]?.entry as Entry;
    expect(held.fix).not.toContain(SECRET);
    expect(held.notes).toBe("");
  });

  it("changes nothing for a fix it holds already, and replaces one that changed", () => {
    const first = accept(emptyRelay(), doc(entry(1), entry(2))).state;
    const same = accept(first, doc(entry(1)));
    expect([same.accepted, same.state.seq]).toEqual([0, 2]);
    const changed = accept(first, doc(entry(1, { fix: "A better fix." })));
    expect(changed.accepted).toBe(1);
    expect(changed.state.fixes.map((f) => [f.seq, f.entry.fix])).toEqual([
      [3, "A better fix."],
      [2, "Fix number 2."],
    ]);
    // The state it was given is left as it was.
    expect(first.fixes[0]?.entry.fix).toBe("Fix number 1.");
  });

  it("refuses new fingerprints once it is full, but still takes changed fixes", () => {
    const full: RelayState = {
      ...emptyRelay(),
      seq: RELAY_MAX_FIXES,
      fixes: Array.from({ length: RELAY_MAX_FIXES }, (_, i) => ({
        seq: i + 1,
        entry: entry(1, {}, { sig: i.toString(16).padStart(12, "0") }),
      })),
    };
    const result = accept(
      full,
      doc(
        entry(9, {}, { sig: "ffffffffffff" }),
        entry(1, { fix: "New." }, { sig: "000000000000" }),
      ),
    );
    expect([result.accepted, result.ignored]).toEqual([1, 1]);
    expect(result.state.fixes).toHaveLength(RELAY_MAX_FIXES);
  });

  it("refuses a document too large, or one that does not parse", () => {
    expect(acceptFixes(emptyRelay(), "x".repeat(RELAY_MAX_BYTES + 1))).toEqual({
      error: `a document over ${RELAY_MAX_BYTES / 1024} KiB`,
    });
    const bad = acceptFixes(emptyRelay(), "## E-1 · no header\n");
    expect("error" in bad && bad.error).toMatch(
      /^a document that does not parse/,
    );
  });
});

describe("fixesSince", () => {
  const state = accept(
    accept(emptyRelay(), doc(entry(1), entry(2))).state,
    doc(entry(1, { fix: "A better fix." })),
  ).state;

  it("sends every fix changed since, oldest change first, numbered afresh", () => {
    const since = fixesSince(state, 0);
    expect([since.seq, since.count]).toEqual([3, 2]);
    expect(since.text.startsWith(`${DOCUMENT_HEADER}\n${RELAY_PREAMBLE}`)).toBe(
      true,
    );
    const entries = parseDocument(since.text).blocks.map((b) => b.entry);
    expect(entries.map((e) => [e.id, e.fix])).toEqual([
      ["E-0001", "Fix number 2."],
      ["E-0002", "A better fix."],
    ]);
  });

  it("sends only what changed after the given number", () => {
    const since = fixesSince(state, 2);
    expect(since.count).toBe(1);
    expect(parseDocument(since.text).blocks[0]?.entry.fix).toBe(
      "A better fix.",
    );
  });

  it("sends nothing when nothing changed", () => {
    expect(fixesSince(state, 3)).toEqual({ seq: 3, text: "", count: 0 });
    expect(fixesSince(emptyRelay(), 0)).toEqual({ seq: 0, text: "", count: 0 });
  });
});

describe("parseRelayState", () => {
  it("reads back what was saved", () => {
    const state = accept(emptyRelay(), doc(entry(1))).state;
    expect(parseRelayState(JSON.stringify(state))).toEqual(state);
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", "null"],
    ["another version", JSON.stringify({ version: 2, seq: 0, fixes: [] })],
    [
      "a bad sequence number",
      JSON.stringify({ version: 1, seq: 1.5, fixes: [] }),
    ],
    [
      "fixes that are not a list",
      JSON.stringify({ version: 1, seq: 0, fixes: {} }),
    ],
    [
      "a fix without a sequence number",
      JSON.stringify({ version: 1, seq: 1, fixes: [{ entry: entry(1) }] }),
    ],
    [
      "a fix without an entry",
      JSON.stringify({ version: 1, seq: 1, fixes: [{ seq: 1, entry: null }] }),
    ],
    [
      "an entry without a fix",
      JSON.stringify({
        version: 1,
        seq: 1,
        fixes: [{ seq: 1, entry: { meta: {} } }],
      }),
    ],
    [
      "an entry without machine fields",
      JSON.stringify({
        version: 1,
        seq: 1,
        fixes: [{ seq: 1, entry: { fix: "x", meta: null } }],
      }),
    ],
  ])("reads %s as nothing", (_name, text) => {
    expect(parseRelayState(text)).toBeUndefined();
  });
});
