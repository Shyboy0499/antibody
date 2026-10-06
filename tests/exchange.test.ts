import { describe, expect, it } from "vitest";
import {
  EXCHANGE_PREAMBLE,
  exportDocument,
  exportable,
  forExport,
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
