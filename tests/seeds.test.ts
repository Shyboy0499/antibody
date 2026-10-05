// Ported from dsh-errkb, tests/seeds.test.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signature } from "../src/signature";
import { formatId, parseDocument, renderEntry } from "../src/store";

// seeds/ANTIBODIES.seed.md is the only memory content this public repository
// carries. These tests keep it exactly what the store would write;
// tests/redact.test.ts keeps it exactly what redaction would leave.
const seedFile = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "seeds",
  "ANTIBODIES.seed.md",
);
const text = readFileSync(seedFile, "utf8");
const document = parseDocument(text);

describe("seeds/ANTIBODIES.seed.md", () => {
  it("parses, with two to three entries numbered from E-0001", () => {
    expect(document.blocks.length).toBeGreaterThanOrEqual(2);
    expect(document.blocks.length).toBeLessThanOrEqual(3);
    expect(document.blocks.map((b) => b.entry.id)).toEqual(
      document.blocks.map((_, n) => formatId(n + 1)),
    );
  });

  it("is exactly what the store renders, in English labels", () => {
    for (const { entry, source } of document.blocks)
      expect(source.replace(/\n+$/, "\n")).toBe(renderEntry(entry, "en"));
  });

  it("carries the real signature of each raw message", () => {
    for (const { entry } of document.blocks) {
      expect(entry.fingerprint).toBe(
        signature(entry.meta.cat as string, entry.raw),
      );
      expect(entry.meta.sig).toBe(entry.fingerprint);
    }
  });

  it("has a fix for every entry, and no device or project field", () => {
    for (const { entry } of document.blocks) {
      expect(entry.fix).not.toBe("");
      expect(entry.meta).not.toHaveProperty("device");
      expect(entry.meta).not.toHaveProperty("proj");
    }
  });

  it("covers the errors parallel agents meet in fresh worktrees", () => {
    const codes = document.blocks.map((b) => b.entry.meta.code);
    expect(codes).toEqual(["ENV_NOT_FOUND", "EADDRINUSE", "WORKTREE_BRANCH"]);
  });
});
