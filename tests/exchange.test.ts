import { describe, expect, it } from "vitest";
import {
  EXCHANGE_PREAMBLE,
  IMPORT_MAX_CHARS,
  exportDocument,
  exportable,
  forExport,
  forImport,
  holdImportedFix,
  plain,
  planImport,
  rejectedKeys,
} from "../src/exchange";
import { DOCUMENT_HEADER, parseDocument } from "../src/store";
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
  meta: { sig: `00000000000${n}`, cat: "tool", first: "2026-10-05", ...meta },
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

describe("exportable", () => {
  it("takes a working fix found in this fleet", () => {
    expect(exportable(entry(1))).toBe(true);
  });

  it("leaves out entries without a fix, with a doubtful status, or waiting for review", () => {
    expect(exportable(entry(1, { fix: "" }))).toBe(false);
    expect(exportable(entry(1, { fix: " \n " }))).toBe(false);
    expect(exportable(entry(1, { status: "open" }))).toBe(false);
    expect(exportable(entry(1, { status: "wontfix" }))).toBe(false);
    expect(exportable(entry(1, {}, { review: "pending" }))).toBe(false);
  });
});

describe("forExport", () => {
  it("redacts every text again, and collapses absolute paths", () => {
    const leaky = entry(1, {
      title: `[tool:Bash] token ${SECRET}`,
      category: `tool / ${SECRET}`,
      trigger: `deploy --token ${SECRET}`,
      raw: `open /opt/shop/.env with ${SECRET}`,
      fix: `Use /opt/shop/.env, not ${SECRET}.`,
    });
    const out = forExport(leaky);
    for (const text of [out.title, out.category, out.trigger, out.raw, out.fix])
      expect(text).not.toContain(SECRET);
    expect(out.fix).toBe("Use <path>/.env, not <secret>.");
    expect(out.raw).toBe("open <path>/.env with <secret>");
  });

  it("drops the notes and the review mark, and keeps the fingerprint as it is", () => {
    const out = forExport(
      entry(1, { notes: "seen on our CI" }, { review: "done", code: SECRET }),
    );
    expect(out.notes).toBe("");
    expect(out.meta).toEqual({
      sig: "000000000001",
      cat: "tool",
      first: "2026-10-05",
      code: "<secret>",
    });
    expect(out.fingerprint).toBe("000000000001");
  });

  it("changes nothing in the entry it was given", () => {
    const original = entry(1, { notes: "mine" }, { review: "done" });
    const before = structuredClone(original);
    forExport(original);
    expect(original).toEqual(before);
  });
});

describe("exportDocument", () => {
  it("writes nothing when no entry is exportable", () => {
    expect(exportDocument([])).toEqual({ text: "", exported: 0 });
    expect(exportDocument([entry(1, { fix: "" })])).toEqual({
      text: "",
      exported: 0,
    });
  });

  it("writes the exportable entries, in order, as a document that parses", () => {
    const { text, exported } = exportDocument([
      entry(1),
      entry(2, { fix: "" }),
      entry(3, { notes: "private note" }),
      entry(4, {}, { review: "pending" }),
    ]);
    expect(exported).toBe(2);
    expect(text.startsWith(`${DOCUMENT_HEADER}\n${EXCHANGE_PREAMBLE}\n`)).toBe(
      true,
    );
    expect(text).not.toContain("private note");
    const document = parseDocument(text);
    expect(document.blocks.map((b) => b.entry.id)).toEqual([
      "E-0001",
      "E-0003",
    ]);
    expect(document.blocks.map((b) => b.entry.fix)).toEqual([
      "Fix number 1.",
      "Fix number 3.",
    ]);
    expect(document.blocks[0]?.entry).toMatchObject({
      fingerprint: "000000000001",
      category: "tool / Bash",
      trigger: "pnpm test",
      raw: "failure number 1",
      status: "fixed",
    });
  });

  it("gives the same text for the same entries, so a re-export changes nothing", () => {
    const entries = [entry(1), entry(2)];
    expect(exportDocument(entries).text).toBe(exportDocument(entries).text);
  });
});

// Fingerprints, as signature() writes them.
const FP = (n: number) => `00000000000${n}`;

describe("plain", () => {
  it("takes out what a terminal could act on, and keeps text, tabs and newlines", () => {
    expect(plain("a\u001b[31mred\u001b[0m\u0007b\u0000c")).toBe(
      "a[31mred[0mbc",
    );
    expect(plain("line one\n\tline two — 日本語 ✓")).toBe(
      "line one\n\tline two — 日本語 ✓",
    );
    expect(plain("a\u009bb\u007fc")).toBe("abc");
  });

  it("takes out what hides from a reader: zero-width, direction and tag characters", () => {
    expect(plain("a\u200bb\u200dc\u2060d\ufeffe")).toBe("abcde");
    expect(plain("fix \u202etxet\u202c \u2066x\u2069")).toBe("fix txet x");
    // "ignore" written in tag characters, which render as nothing.
    const hidden = Array.from("ignore", (c) =>
      String.fromCodePoint(0xe0000 + c.charCodeAt(0)),
    ).join("");
    expect(plain(`run it${hidden}`)).toBe("run it");
  });
});

describe("forImport", () => {
  const incoming = (
    extra: Partial<Entry> = {},
    meta: Record<string, string> = {},
  ) => entry(1, extra, meta);

  it("holds the whole entry for review, and notes where it came from", () => {
    const out = forImport(incoming(), "ANTIBODIES.md");
    expect(out).toEqual({
      title: "[tool:Bash] failure number 1",
      signature: FP(1),
      category: "tool / Bash",
      meta: { review: "fix+text", cat: "tool", first: "2026-10-05" },
      trigger: "pnpm test",
      raw: "failure number 1",
      fix: "Fix number 1.",
      status: "fixed",
      notes: "Imported from ANTIBODIES.md.",
    });
  });

  it("keeps only the machine fields that matter, and none the file can use to vouch for itself", () => {
    const out = forImport(
      incoming(
        {},
        { review: "", misjudged: "true", code: "E1", proj: "shop", extra: "x" },
      ),
      "f.md",
    );
    expect(out.meta).toEqual({
      review: "fix+text",
      cat: "tool",
      code: "E1",
      proj: "shop",
      first: "2026-10-05",
    });
  });

  it("puts each text on a line, takes the control characters out, and cuts it to length", () => {
    const out = forImport(
      incoming({
        title: `[tool] \u001b[2Jwipe\nscreen ${"t".repeat(300)}`,
        category: "x".repeat(200),
        trigger: "a\u0007\nb",
        raw: "raw\u001b[31m text",
        fix: `  ${"f".repeat(1500)}\u0000  `,
      }),
      "f.md",
    );
    expect(out.title).toHaveLength(IMPORT_MAX_CHARS.title);
    expect(out.title.startsWith("[tool] [2Jwipe screen ttt")).toBe(true);
    expect(out.category).toHaveLength(IMPORT_MAX_CHARS.category);
    expect(out.trigger).toBe("a b");
    expect(out.raw).toBe("raw[31m text");
    expect(out.fix).toHaveLength(IMPORT_MAX_CHARS.fix);
    expect(out.fix?.endsWith("…")).toBe(true);
  });

  it("identifies the entry by its machine fingerprint, then by its own", () => {
    expect(
      forImport(incoming({ fingerprint: FP(7) }, { sig: FP(2) }), "f")
        .signature,
    ).toBe(FP(2));
    const bare = incoming({ fingerprint: FP(7) });
    delete bare.meta.sig;
    expect(forImport(bare, "f").signature).toBe(FP(7));
  });
});

describe("planImport", () => {
  const none = {
    "no-fix": 0,
    duplicate: 0,
    "bad-fingerprint": 0,
    rejected: 0,
    wontfix: 0,
    full: 0,
  };

  it("adds what this machine has not met, held for review", () => {
    const plan = planImport([], [entry(1), entry(2)], 10, "f.md");
    expect(plan.add.map((e) => e.signature)).toEqual([FP(1), FP(2)]);
    expect(plan.add[0]?.meta?.review).toBe("fix+text");
    expect(plan).toMatchObject({ adopt: [], known: 0, skipped: none });
  });

  it("leaves an entry that already has a fix alone, held or not", () => {
    const local = [entry(1), entry(2, {}, { review: "fix" })];
    const plan = planImport(
      local,
      [entry(1, { fix: "Other." }), entry(2)],
      10,
      "f",
    );
    expect(plan).toMatchObject({ add: [], adopt: [], known: 2, skipped: none });
  });

  it("gives a fix to an entry that has none", () => {
    const local = [entry(1, { fix: "", status: "open", id: "E-0009" })];
    const plan = planImport(
      local,
      [entry(1, { fix: "A\u0007 fix." })],
      10,
      "f",
    );
    expect(plan.adopt).toEqual([{ id: "E-0009", fix: "A fix." }]);
    expect(plan.add).toEqual([]);
  });

  it("respects a wontfix", () => {
    const local = [entry(1, { fix: "", status: "wontfix" })];
    const plan = planImport(local, [entry(1)], 10, "f");
    expect(plan).toMatchObject({ add: [], adopt: [] });
    expect(plan.skipped.wontfix).toBe(1);
  });

  it("skips what is not a working fix, not a fingerprint, or a repeat", () => {
    const incoming = [
      entry(1, { fix: "" }),
      entry(2, { status: "open" }),
      entry(3, { fingerprint: "../etc", meta: { sig: "../etc" } }),
      entry(4),
      entry(4, { fix: "A second answer." }),
    ];
    const plan = planImport([], incoming, 10, "f");
    expect(plan.add.map((e) => e.signature)).toEqual([FP(4)]);
    expect(plan.add[0]?.fix).toBe("Fix number 4.");
    expect(plan.skipped).toEqual({
      ...none,
      "no-fix": 2,
      "bad-fingerprint": 1,
      duplicate: 1,
    });
  });

  it("adds no more than the memory has room for", () => {
    const plan = planImport([], [entry(1), entry(2), entry(3)], 1, "f");
    expect(plan.add.map((e) => e.signature)).toEqual([FP(1)]);
    expect(plan.skipped.full).toBe(2);
    expect(planImport([], [entry(1)], 0, "f").skipped.full).toBe(1);
  });
});

describe("holdImportedFix", () => {
  it("holds the fix, and keeps held text held", () => {
    expect(holdImportedFix({})).toEqual({ review: "fix" });
    expect(holdImportedFix({ review: "fix" })).toEqual({ review: "fix" });
    expect(holdImportedFix({ review: "text" })).toEqual({ review: "fix+text" });
  });
});

describe("rejectedKeys", () => {
  it("names the entries a person rejected, and no others in the archive", () => {
    const archive = [
      entry(1, {}, { review: "rejected" }),
      entry(2),
      entry(3, {}, { review: "fix" }),
    ];
    expect([...rejectedKeys(archive)]).toEqual([FP(1)]);
    expect(rejectedKeys([]).size).toBe(0);
  });
});

describe("planImport: what a person rejected", () => {
  it("is left out, even for an entry this machine met again since", () => {
    const local = [entry(2, { fix: "", status: "open" })];
    const plan = planImport(
      local,
      [entry(1), entry(2)],
      10,
      "f",
      new Set([FP(1), FP(2)]),
    );
    expect(plan).toMatchObject({ add: [], adopt: [], known: 0 });
    expect(plan.skipped.rejected).toBe(2);
  });

  it("counts a repeat of a rejected entry once", () => {
    const plan = planImport(
      [],
      [entry(1), entry(1)],
      10,
      "f",
      new Set([FP(1)]),
    );
    expect(plan.skipped).toMatchObject({ rejected: 1, duplicate: 1 });
  });
});
