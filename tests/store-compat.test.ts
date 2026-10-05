import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  META_PREFIX,
  ParseError,
  parseDocument,
  renderDocument,
  renderEntry,
} from "../src/store";

// antibody writes `<!-- antibody: ... -->`; dsh-errkb wrote `<!-- errkb: ... -->`.
// A dsh-errkb document must still read, unchanged, so a fleet can start from
// the knowledge a single agent already gathered.
const seedText = readFileSync(
  resolve(
    fileURLToPath(new URL("..", import.meta.url)),
    "seeds",
    "ANTIBODIES.seed.md",
  ),
  "utf8",
);
const errkbText = seedText.replaceAll("<!-- antibody:", "<!-- errkb:");

describe("the machine comment", () => {
  it("is written with antibody's prefix", () => {
    expect(META_PREFIX).toBe("antibody");
    const [first] = parseDocument(seedText).blocks;
    expect(renderEntry(first!.entry)).toContain("\n<!-- antibody: sig=");
  });

  it("reads a dsh-errkb document with the same entries", () => {
    const ours = parseDocument(seedText).blocks.map((b) => b.entry);
    const theirs = parseDocument(errkbText).blocks.map((b) => b.entry);
    expect(theirs).toEqual(ours);
  });

  it("leaves a dsh-errkb document byte for byte as it was", () => {
    expect(renderDocument(parseDocument(errkbText))).toBe(errkbText);
  });

  it("switches an entry to antibody's prefix only when it is rendered again", () => {
    const [block] = parseDocument(errkbText).blocks;
    expect(block!.source).toContain("<!-- errkb:");
    expect(renderEntry(block!.entry)).toContain("<!-- antibody:");
    expect(renderEntry(block!.entry)).not.toContain("<!-- errkb:");
  });

  it("still rejects an entry with no machine comment, naming the prefix", () => {
    const broken = seedText.replace(/^<!-- antibody:.*\n/m, "");
    expect(() => parseDocument(broken)).toThrow(ParseError);
    expect(() => parseDocument(broken)).toThrow("<!-- antibody: ... -->");
  });
});
