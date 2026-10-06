import { describe, expect, it } from "vitest";
import {
  HELD_TITLE,
  REVIEW_ALL,
  REVIEW_KEY,
  afterOwnFix,
  displayTitle,
  forAgents,
  heldParts,
  pendingReview,
} from "../src/review";
import type { Entry } from "../src/store";

const entry = (meta: Record<string, string>, extra: Partial<Entry> = {}) =>
  ({
    id: "E-0001",
    title: "[tool:Bash] error",
    meta: { sig: "aaaa", ...meta },
    fingerprint: "aaaa",
    category: "command-exit / Bash",
    firstSeen: "2026-10-05",
    lastSeen: "2026-10-05",
    hits: 1,
    trigger: "pnpm test",
    raw: "Error: boom",
    fix: "Run pnpm install.",
    status: "fixed",
    notes: "a note",
    ...extra,
  }) satisfies Entry;

describe("heldParts", () => {
  it.each([
    [{}, false, false],
    [{ [REVIEW_KEY]: "" }, false, false],
    [{ [REVIEW_KEY]: "fix" }, true, false],
    [{ [REVIEW_KEY]: "text" }, false, true],
    [{ [REVIEW_KEY]: REVIEW_ALL }, true, true],
    [{ [REVIEW_KEY]: "text+fix" }, true, true],
    // A mark this version does not know holds everything.
    [{ [REVIEW_KEY]: "pending" }, true, true],
    [{ [REVIEW_KEY]: "fix+later" }, true, true],
  ])("reads %j as fix %s, text %s", (meta, fix, text) => {
    expect(heldParts(meta)).toEqual({ fix, text });
    expect(pendingReview(entry(meta))).toBe(fix || text);
  });
});

describe("forAgents", () => {
  it("leaves an entry with nothing held as it is", () => {
    const reviewed = entry({});
    expect(forAgents(reviewed)).toBe(reviewed);
  });

  it("holds back a fix alone, and reopens the entry", () => {
    const held = entry({ review: "fix" });
    expect(forAgents(held)).toEqual({ ...held, fix: "", status: "open" });
    expect(held.fix).toBe("Run pnpm install.");
  });

  it("holds back text alone, and keeps the fix", () => {
    const held = entry({ review: "text" });
    expect(forAgents(held)).toEqual({
      ...held,
      title: "",
      category: "",
      trigger: "",
      raw: "",
      notes: "",
    });
  });

  it("holds back both, and keeps the fingerprint and the machine fields", () => {
    const held = entry({ review: REVIEW_ALL, code: "E1" });
    expect(forAgents(held)).toEqual({
      ...held,
      title: "",
      category: "",
      trigger: "",
      raw: "",
      notes: "",
      fix: "",
      status: "open",
    });
  });

  it("keeps a held entry's wontfix", () => {
    const wontfix = entry({ review: REVIEW_ALL }, { status: "wontfix" });
    expect(forAgents(wontfix)).toMatchObject({ fix: "", status: "wontfix" });
  });
});

describe("displayTitle", () => {
  it("replaces a held title, and only that", () => {
    expect(displayTitle(entry({ review: REVIEW_ALL }))).toBe(HELD_TITLE);
    expect(displayTitle(entry({ review: "text" }))).toBe(HELD_TITLE);
    expect(displayTitle(entry({ review: "fix" }))).toBe("[tool:Bash] error");
    expect(displayTitle(entry({}))).toBe("[tool:Bash] error");
  });
});

describe("afterOwnFix", () => {
  it("releases a held fix, but not held text", () => {
    expect(afterOwnFix({})).toEqual({ review: null });
    expect(afterOwnFix({ review: "fix" })).toEqual({ review: null });
    expect(afterOwnFix({ review: "text" })).toEqual({ review: "text" });
    expect(afterOwnFix({ review: REVIEW_ALL })).toEqual({ review: "text" });
    expect(afterOwnFix({ review: "pending" })).toEqual({ review: "text" });
  });
});
