// Ported from dsh-errkb, tests/paths.test.ts (MIT, Copyright (c) 2026
// jingchangzhao-gif; see NOTICE): the "file names" cases, which cover the part
// of src/paths.ts antibody keeps.
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KB_FILE, corruptFileName, filesIn } from "../src/paths";

describe("file names", () => {
  it("names the files for antibody", () => {
    expect(KB_FILE).toEqual({
      errors: "ANTIBODIES.md",
      archive: "ANTIBODIES.archive.md",
      index: "antibodies.index.json",
      state: "state.json",
      machine: ".machine.json",
      lock: ".lock",
      events: "events.jsonl",
      claims: "claims.json",
    });
  });

  it("derives every path from the directory", () => {
    const dir = join(resolve("/memory"), "antibody");
    expect(filesIn(dir)).toEqual({
      errors: join(dir, "ANTIBODIES.md"),
      archive: join(dir, "ANTIBODIES.archive.md"),
      index: join(dir, "antibodies.index.json"),
      state: join(dir, "state.json"),
      machine: join(dir, ".machine.json"),
      lock: join(dir, ".lock"),
      events: join(dir, "events.jsonl"),
      claims: join(dir, "claims.json"),
    });
  });

  it("keeps every name relative: no drive letter and no separator", () => {
    for (const name of Object.values(KB_FILE)) {
      expect(name).not.toMatch(/^[A-Za-z]:/);
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
    }
  });

  it("names a corrupt document copy with a Windows-legal stamp", () => {
    const name = corruptFileName(new Date("2026-09-27T01:02:03.004Z"));
    expect(name).toBe("ANTIBODIES.corrupt-2026-09-27T01-02-03-004Z.md");
    expect(name).not.toContain(":");
    expect(dirname(name)).toBe(".");
  });
});
