// Ported from dsh-errkb, tests/inject.test.ts (MIT, Copyright (c) 2026
// jingchangzhao-gif; see NOTICE): the cases for the notice text and the caps.
import { describe, expect, it } from "vitest";
import type { Hit } from "../src/match";
import {
  CAUSE_MAX_CHARS,
  CLAIM_HINT_MAX_TOKENS,
  CAUSE_MIN_CHARS,
  CapTracker,
  DEFAULT_CAP_LIMITS,
  ELLIPSIS,
  NOTICE_MAX_CHARS,
  NOTICE_MAX_TOKENS,
  NOTICE_PREFIX,
  WORDING,
  claimHintText,
  clip,
  elapsedText,
  estimateTokens,
  fitNotice,
  noticeText,
  oneLine,
  withinCaps,
} from "../src/notice";
import type { NoticeEvent } from "../src/notice";
import type { Entry } from "../src/store";

// ---------------------------------------------------------------------------
// Fixtures

const FIX =
  "close the locking process and re-run; if it persists, use pnpm install --config.node-linker=hoisted.";
const CAUSE = "node_modules locked by an editor during pnpm install";

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    title: "[tool:pwsh] EPERM: operation not permitted, rename",
    meta: { sig: "3f2a1c9d0b71", cat: "tool" },
    fingerprint: "3f2a1c9d0b71",
    category: "tool / pwsh",
    firstSeen: "2026-09-14 09:12",
    lastSeen: "2026-09-14 15:40",
    hits: 5,
    trigger: CAUSE,
    raw: "EPERM: operation not permitted, rename '<path>'",
    fix: FIX,
    status: "open",
    notes: "",
    ...overrides,
  };
}

function hit(
  id = "E-0007",
  overrides: Partial<Entry> = {},
  extra: Partial<Hit> = {},
): NoticeEvent {
  return {
    kind: "hit",
    hit: {
      matched: true,
      id,
      entry: entry(id, overrides),
      via: "exact",
      approximate: false,
      similarity: 1,
      injectable: true,
      ...extra,
    },
  };
}

const near = (id = "E-0007", overrides: Partial<Entry> = {}) =>
  hit(id, overrides, { via: "fuzzy", approximate: true, similarity: 0.8 });

const miss = (id = "E-0011"): NoticeEvent => ({ kind: "miss", id });

const cjk = (n: number) => "关闭占用该目录的编辑器后重跑".repeat(n);

// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("counts ASCII at three characters a token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("a\tb\nc")).toBe(2);
  });

  it("counts every CJK character as a token", () => {
    expect(estimateTokens("拒绝访问")).toBe(4);
    expect(estimateTokens("EPERM 拒绝访问")).toBe(2 + 4);
  });

  it("counts a character outside the BMP once", () => {
    expect("𠮷".length).toBe(2);
    expect(estimateTokens("𠮷")).toBe(1);
    expect(estimateTokens("ab𠮷c")).toBe(1 + 1);
  });

  it("overestimates English: 120 tokens is at most 360 ASCII characters", () => {
    expect(estimateTokens("x".repeat(360))).toBe(120);
    expect(estimateTokens("x".repeat(361))).toBe(121);
  });
});

describe("text helpers", () => {
  it("withinCaps checks both the character and the token cap", () => {
    expect(withinCaps("x".repeat(360))).toBe(true);
    expect(withinCaps("x".repeat(361))).toBe(false);
    expect(withinCaps("拒".repeat(NOTICE_MAX_TOKENS))).toBe(true);
    expect(withinCaps("拒".repeat(NOTICE_MAX_TOKENS + 1))).toBe(false);
  });

  it("oneLine collapses whitespace and newlines", () => {
    expect(oneLine("  a\n\n b\t c ")).toBe("a b c");
  });

  it("clip cuts by code point and marks the cut", () => {
    expect(clip("abcdef", 6)).toBe("abcdef");
    expect(clip("abcdef", 4)).toBe(`abc${ELLIPSIS}`);
    expect(clip("ab   cdef", 4)).toBe(`ab${ELLIPSIS}`);
    expect(clip("拒绝访问", 3)).toBe(`拒绝${ELLIPSIS}`);
    expect(clip("𠮷𠮷𠮷", 2)).toBe(`𠮷${ELLIPSIS}`);
    expect(clip("abc", 0)).toBe("");
    expect(clip("", 0)).toBe("");
  });
});

describe("fitNotice", () => {
  const render = (c: string, f: string) => `[h] ${c} | ${f} END`;

  it("leaves short text alone, apart from the cause cap", () => {
    expect(fitNotice(render, "c", "f")).toBe("[h] c | f END");
    const long = "c".repeat(CAUSE_MAX_CHARS + 20);
    expect(fitNotice(render, long, "f")).toBe(
      `[h] ${clip(long, CAUSE_MAX_CHARS)} | f END`,
    );
  });

  it("shrinks the cause before the fix", () => {
    const cause = "c".repeat(CAUSE_MAX_CHARS);
    const fix = "f".repeat(250);
    const text = fitNotice(render, cause, fix);
    expect(withinCaps(text)).toBe(true);
    expect(text).toContain(` | ${fix} END`);
    expect(text).toContain(ELLIPSIS);
  });

  it("then shrinks the fix, keeping the template whole", () => {
    const text = fitNotice(render, cjk(10), cjk(10));
    expect(withinCaps(text)).toBe(true);
    expect(text.startsWith("[h] ")).toBe(true);
    expect(text.endsWith(`${ELLIPSIS} END`)).toBe(true);
    expect(text).toContain(`${clip(cjk(10), CAUSE_MIN_CHARS)} |`);
  });

  it("clips the whole body when the template alone is too long", () => {
    const huge = (c: string, f: string) => `${"x".repeat(500)} ${c} ${f}`;
    const text = fitNotice(huge, "c", "f");
    expect(withinCaps(text)).toBe(true);
    expect(text.endsWith(ELLIPSIS)).toBe(true);
  });
});

describe("noticeText", () => {
  it("a hit carries cause, fix and the try-first wording", () => {
    expect(noticeText(hit())).toEqual({
      kind: "hit",
      text: `[antibody] E-0007 known (5 hits) | cause: ${CAUSE} | fix: ${FIX} ${WORDING.hit}`,
    });
  });

  it("the hit wording never forbids re-diagnosis or research", () => {
    expect(WORDING.hit).toBe(
      "Known fix: try this first, before re-diagnosing or researching.",
    );
    expect(noticeText(hit()).text).not.toMatch(/do not/i);
  });

  it("says 1 hit, singular", () => {
    expect(noticeText(hit("E-0001", { hits: 1 })).text).toContain(
      "E-0001 known (1 hit) |",
    );
  });

  it("leaves the cause out when the entry has no trigger", () => {
    expect(noticeText(hit("E-0007", { trigger: "  " })).text).toBe(
      `[antibody] E-0007 known (5 hits) | fix: ${FIX} ${WORDING.hit}`,
    );
  });

  it("joins a multi-line fix into one line", () => {
    const text = noticeText(
      hit("E-0007", { fix: "step one\n\nstep two" }),
    ).text;
    expect(text).toContain("| fix: step one step two Known fix:");
    expect(text).not.toContain("\n");
  });

  it("a near hit says approximate match, verify first, and nothing stronger", () => {
    const { kind, text } = noticeText(near());
    expect(kind).toBe("near");
    expect(text).toBe(
      `[antibody] E-0007 known (5 hits) | cause: ${CAUSE} | fix: ${FIX} Approximate match, verify first.`,
    );
    expect(text).not.toContain(WORDING.hit);
    expect(text).not.toMatch(/re-diagnos/);
  });

  it("an entry without a fix gets the short notice", () => {
    expect(noticeText(hit("E-0007", { fix: " \n " }))).toEqual({
      kind: "no-fix",
      text: "[antibody] E-0007 seen before (5 hits), no fix recorded yet.",
    });
    expect(noticeText(near("E-0007", { fix: "" })).text).toBe(
      "[antibody] E-0007 seen before (5 hits, approximate match), no fix recorded yet.",
    );
    expect(
      estimateTokens(noticeText(hit("E-0007", { fix: "" })).text),
    ).toBeLessThanOrEqual(20);
  });

  it("a miss is recorded with no fix yet", () => {
    expect(noticeText(miss())).toEqual({
      kind: "miss",
      text: "[antibody] recorded as E-0011 (no fix yet).",
    });
  });

  it("a doubted fix says it failed here last time", () => {
    const { kind, text } = noticeText(hit(), "doubted");
    expect(kind).toBe("doubted");
    expect(
      text.endsWith(" This fix failed here last time; verify before applying."),
    ).toBe(true);
    expect(text).not.toContain(WORDING.hit);
  });

  it("a doubted near hit says both", () => {
    const { kind, text } = noticeText(near(), "doubted");
    expect(kind).toBe("doubted");
    expect(text.endsWith(`${WORDING.approximate} ${WORDING.doubted}`)).toBe(
      true,
    );
  });

  it("a doubted entry without a fix is still the short notice", () => {
    expect(noticeText(hit("E-0007", { fix: "" }), "doubted").kind).toBe(
      "no-fix",
    );
  });
});

describe("caps on the body", () => {
  it("keeps a long English fix within 400 characters and 120 tokens", () => {
    const fix = "re-run pnpm install after closing the editor ".repeat(20);
    const { text } = noticeText(
      hit("E-0007", { fix, trigger: CAUSE.repeat(5) }),
    );
    expect(Array.from(text).length).toBeLessThanOrEqual(NOTICE_MAX_CHARS);
    expect(estimateTokens(text)).toBeLessThanOrEqual(NOTICE_MAX_TOKENS);
    expect(text.endsWith(WORDING.hit)).toBe(true);
  });

  it("keeps a CJK-heavy fix within 120 tokens, ending with the instruction", () => {
    const { text } = noticeText(
      hit("E-0007", { fix: cjk(30), trigger: cjk(10) }),
    );
    expect(estimateTokens(text)).toBeLessThanOrEqual(NOTICE_MAX_TOKENS);
    expect(Array.from(text).length).toBeLessThanOrEqual(NOTICE_MAX_CHARS);
    expect(text).toContain(`${ELLIPSIS} ${WORDING.hit}`);
    // The cause gave way first, to its floor.
    expect(text).toContain(`cause: ${clip(cjk(10), CAUSE_MIN_CHARS)} |`);
  });

  it("keeps every wording within the caps", () => {
    const heavy = { fix: cjk(30), trigger: cjk(10) };
    for (const event of [hit("E-0007", heavy), near("E-0007", heavy)])
      for (const trust of ["trusted", "doubted"] as const)
        expect(withinCaps(noticeText(event, trust).text)).toBe(true);
  });

  it("clips an absurd ID rather than break the cap", () => {
    const id = `E-${"9".repeat(600)}`;
    for (const event of [hit(id), hit(id, { fix: "" }), miss(id)]) {
      const { text } = noticeText(event);
      expect(withinCaps(text)).toBe(true);
      expect(text.endsWith(ELLIPSIS)).toBe(true);
    }
  });
});

describe("CapTracker", () => {
  it("defaults to 1 per step, 3 per turn renewed every 10 steps, 2 per ID, 1 for a fixed entry", () => {
    expect(DEFAULT_CAP_LIMITS).toEqual({
      perStep: 1,
      perTurn: 3,
      perIdPerSession: 2,
      fixedPerSession: 1,
      renewAfterSteps: 10,
    });
    expect(new CapTracker().limits).toEqual(DEFAULT_CAP_LIMITS);
  });

  it("allows at most one notice per step", () => {
    const caps = new CapTracker();
    expect(caps.tryEmit("E-0001")).toBe(true);
    expect(caps.tryEmit("E-0002")).toBe(false);
    caps.beginStep();
    expect(caps.tryEmit("E-0002")).toBe(true);
  });

  it("allows at most three notices per turn", () => {
    const caps = new CapTracker();
    const emitted = ["E-1", "E-2", "E-3", "E-4"].map((id) => {
      caps.beginStep();
      return caps.tryEmit(id);
    });
    expect(emitted).toEqual([true, true, true, false]);
    caps.beginTurn();
    expect(caps.tryEmit("E-4")).toBe(true);
  });

  it("starts a long turn's budget again every ten steps", () => {
    const caps = new CapTracker();
    const emitted = Array.from({ length: 12 }, (_, i) => {
      caps.beginStep();
      return caps.tryEmit(`E-${i + 1}`);
    });
    // Steps 1 to 3 spend the turn's budget; step 10 starts it again.
    expect(emitted).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it("allows at most two notices per ID per session, across turns", () => {
    const caps = new CapTracker();
    const emitted = [1, 2, 3].map(() => {
      caps.beginTurn();
      return caps.tryEmit("E-0007");
    });
    expect(emitted).toEqual([true, true, false]);
  });

  it("lets a fixed entry speak once per session", () => {
    const caps = new CapTracker();
    expect(caps.tryEmit("E-0007", true)).toBe(true);
    caps.beginTurn();
    expect(caps.tryEmit("E-0007", true)).toBe(false);
  });

  it("takes nothing from any budget when it refuses", () => {
    const caps = new CapTracker();
    expect(caps.tryEmit("E-0007", true)).toBe(true);
    caps.beginStep();
    expect(caps.tryEmit("E-0007", true)).toBe(false);
    // The refusal did not use up this step.
    expect(caps.tryEmit("E-0008")).toBe(true);
  });

  it("lets a hand-over past the turn's budget without spending it", () => {
    const caps = new CapTracker();
    caps.beginStep();
    expect(caps.tryEmit("E-1\0hold", false, true)).toBe(true);
    for (const id of ["E-2", "E-3", "E-4"]) {
      caps.beginStep();
      expect(caps.tryEmit(id)).toBe(true);
    }
    caps.beginStep();
    expect(caps.tryEmit("E-5")).toBe(false);
  });

  it("lets a promised fix past the turn's budget, not the step's or the entry's", () => {
    const caps = new CapTracker();
    for (const id of ["E-1", "E-2", "E-3"]) {
      caps.beginStep();
      caps.tryEmit(id);
    }
    caps.beginStep();
    expect(caps.tryEmit("E-4")).toBe(false);
    expect(caps.tryEmit("E-4", true, true)).toBe(true);
    // Still one per step.
    expect(caps.tryEmit("E-5", false, true)).toBe(false);
    caps.beginStep();
    // Still once for a fixed entry.
    expect(caps.tryEmit("E-4", true, true)).toBe(false);
  });

  it("only tightens limits", () => {
    expect(new CapTracker({ renewAfterSteps: 5 }).limits.renewAfterSteps).toBe(
      10,
    );
    expect(new CapTracker({ renewAfterSteps: 20 }).limits.renewAfterSteps).toBe(
      20,
    );
    const caps = new CapTracker({ perTurn: 1, perStep: 5 });
    expect(caps.limits).toEqual({ ...DEFAULT_CAP_LIMITS, perTurn: 1 });
    expect(caps.tryEmit("E-1")).toBe(true);
    caps.beginStep();
    expect(caps.tryEmit("E-2")).toBe(false);
  });

  it("keeps sessions apart: one tracker each", () => {
    const a = new CapTracker();
    const b = new CapTracker();
    a.tryEmit("E-0007");
    a.beginTurn();
    a.tryEmit("E-0007");
    expect(b.tryEmit("E-0007")).toBe(true);
  });
});

describe("the prefix", () => {
  it("opens every kind of notice", () => {
    expect(NOTICE_PREFIX).toBe("[antibody]");
    const events = [hit(), near(), hit("E-0007", { fix: "" }), miss()];
    for (const event of events)
      expect(noticeText(event).text.startsWith(`${NOTICE_PREFIX} `)).toBe(true);
    expect(
      noticeText(hit(), "doubted").text.startsWith(`${NOTICE_PREFIX} `),
    ).toBe(true);
  });
});

describe("CapTracker snapshots", () => {
  it("carries the budgets over to the next process", () => {
    const first = new CapTracker();
    expect(first.tryEmit("E-0001")).toBe(true);
    const next = CapTracker.restore(
      JSON.parse(JSON.stringify(first.snapshot())),
    );
    expect(next.snapshot()).toEqual({
      step: 1,
      turn: 1,
      steps: 0,
      perId: { "E-0001": 1 },
    });
    expect(next.tryEmit("E-0002")).toBe(false);
    next.beginStep();
    expect(next.tryEmit("E-0001")).toBe(true);
    next.beginStep();
    expect(next.tryEmit("E-0001")).toBe(false);
  });

  it("carries the steps toward the turn's next budget over, too", () => {
    const first = new CapTracker();
    for (let i = 0; i < 3; i++) {
      first.beginStep();
      first.tryEmit(`E-${i}`);
    }
    for (let i = 3; i < 9; i++) first.beginStep();
    const next = CapTracker.restore(
      JSON.parse(JSON.stringify(first.snapshot())),
    );
    expect(next.snapshot().steps).toBe(9);
    next.beginStep();
    expect(next.tryEmit("E-9")).toBe(true);
  });

  it("starts fresh without a snapshot, and keeps the limits it is given", () => {
    const caps = CapTracker.restore(undefined, { perTurn: 1 });
    expect(caps.snapshot()).toEqual({ step: 0, turn: 0, steps: 0, perId: {} });
    expect(caps.limits.perTurn).toBe(1);
  });

  it("counts anything malformed as zero", () => {
    const caps = CapTracker.restore({
      step: -1,
      turn: 2.5,
      steps: "3" as unknown as number,
      perId: { "E-1": "2" as unknown as number, "E-2": 1, "E-3": -4, "E-4": 0 },
    });
    expect(caps.snapshot()).toEqual({
      step: 0,
      turn: 0,
      steps: 0,
      perId: { "E-2": 1 },
    });
    expect(
      CapTracker.restore({
        perId: null as unknown as Record<string, number>,
      }).snapshot(),
    ).toEqual({ step: 0, turn: 0, steps: 0, perId: {} });
  });
});

describe("claim hints", () => {
  it("says who is on it, for how long, and that the fix will follow", () => {
    expect(claimHintText("E-0007", "codex-2", 40_000)).toBe(
      "[antibody] E-0007: codex-2 has been diagnosing this for 40 s. Its fix will be passed to you when it is recorded.",
    );
  });

  it("states the time in seconds, minutes or hours", () => {
    expect(elapsedText(-5)).toBe("0 s");
    expect(elapsedText(59_999)).toBe("59 s");
    expect(elapsedText(60_000)).toBe("1 min");
    expect(elapsedText(3_599_999)).toBe("59 min");
    expect(elapsedText(7_200_000)).toBe("2 h");
  });

  it("stays under the hint's own token cap, clipping a long agent name", () => {
    for (const holder of [
      "claude-code@agent-a",
      "x".repeat(200),
      "代理".repeat(40),
    ]) {
      const text = claimHintText("E-0007", holder, 125_000);
      expect(withinCaps(text)).toBe(true);
      expect(estimateTokens(text)).toBeLessThanOrEqual(CLAIM_HINT_MAX_TOKENS);
      expect(text.endsWith("when it is recorded.")).toBe(true);
    }
  });

  it("clips the whole hint when even a one-character name cannot fit", () => {
    const text = claimHintText("E-".repeat(200), "codex-2", 0);
    expect(withinCaps(text)).toBe(true);
  });
});
