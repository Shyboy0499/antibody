import { describe, expect, it } from "vitest";
import {
  REVIEW_KEY,
  REVIEW_PENDING,
  forAgents,
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
    trigger: "",
    raw: "",
    fix: "Run pnpm install.",
    status: "fixed",
    notes: "",
    ...extra,
  }) satisfies Entry;

describe("pendingReview", () => {
  it("reads the review mark", () => {
    expect(pendingReview(entry({ [REVIEW_KEY]: REVIEW_PENDING }))).toBe(true);
    expect(pendingReview(entry({}))).toBe(false);
    expect(pendingReview(entry({ [REVIEW_KEY]: "done" }))).toBe(false);
  });
});

describe("forAgents", () => {
  it("leaves a reviewed entry as it is", () => {
    const reviewed = entry({});
    expect(forAgents(reviewed)).toBe(reviewed);
  });

  it("hides a pending fix, and reopens the entry", () => {
    const pending = entry({ review: "pending" });
    expect(forAgents(pending)).toEqual({ ...pending, fix: "", status: "open" });
    expect(pending.fix).toBe("Run pnpm install.");
  });

  it("keeps a pending entry's wontfix", () => {
    const wontfix = entry({ review: "pending" }, { status: "wontfix" });
    expect(forAgents(wontfix)).toMatchObject({ fix: "", status: "wontfix" });
  });
});
