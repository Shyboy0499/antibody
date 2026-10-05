// Ported from dsh-errkb, tests/inject.test.ts (MIT, Copyright (c) 2026
// jingchangzhao-gif; see NOTICE): the cases for the injector. dsh-errkb's
// assertions on the DeepSeek Harness message source are left out, since
// antibody's notices are plain text.
import { describe, expect, it } from "vitest";
import { Injector } from "../src/injector";
import type { Hit } from "../src/match";
import {
  CapTracker,
  INJECT_MODES,
  WORDING,
  noticeText,
  withinCaps,
} from "../src/notice";
import type { InjectMode, NoticeEvent } from "../src/notice";
import type { Entry } from "../src/store";
import { FixTrust } from "../src/trust";

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

describe("Injector", () => {
  it("defaults to hit-only", () => {
    expect(new Injector().mode).toBe("hit-only");
    expect(INJECT_MODES).toEqual(["hit-only", "always", "off"]);
  });

  it("emits a hit", () => {
    const notice = new Injector().offer(hit());
    expect(notice).toEqual({
      id: "E-0007",
      kind: "hit",
      text: noticeText(hit()).text,
    });
  });

  it("handles a miss according to the inject setting", () => {
    const by = (mode: InjectMode) => new Injector({ mode }).offer(miss());
    expect(by("hit-only")).toBeUndefined();
    expect(by("off")).toBeUndefined();
    expect(by("always")).toMatchObject({
      id: "E-0011",
      kind: "miss",
      text: "[antibody] recorded as E-0011 (no fix yet).",
    });
  });

  it("ask(): the one-shot fix prompt, under the step and turn caps (T14)", () => {
    const injector = new Injector({ caps: new CapTracker() });
    const asked = injector.ask("E-0011");
    expect(asked).toEqual({
      id: "E-0011",
      kind: "ask-fix",
      text: "[antibody] E-0011 looks resolved. Record the fix with antibody_record in one sentence so it can be reused.",
    });
    // One notice per step.
    expect(injector.ask("E-0012")).toBeUndefined();
    expect(new Injector({ mode: "off" }).ask("E-0011")).toBeUndefined();
  });

  it("ask() has its own per-ID budget, apart from the entry's notices", () => {
    const injector = new Injector();
    const noFix = hit("E-0007", { fix: "" });
    for (let i = 0; i < 2; i++) {
      injector.beginTurn();
      expect(injector.offer(noFix)?.kind).toBe("no-fix");
    }
    injector.beginTurn();
    expect(injector.offer(noFix)).toBeUndefined();
    expect(injector.ask("E-0007")?.kind).toBe("ask-fix");
  });

  it("says nothing at all when inject is off", () => {
    const injector = new Injector({ mode: "off" });
    expect(injector.offer(hit())).toBeUndefined();
    expect(injector.offer(near())).toBeUndefined();
    expect(injector.trust.snapshot()).toEqual({ entries: {} });
  });

  it("emits hits under always too", () => {
    expect(new Injector({ mode: "always" }).offer(hit())?.kind).toBe("hit");
  });

  it("never speaks for a non-injectable entry", () => {
    const injector = new Injector({ mode: "always" });
    for (const excluded of ["wontfix", "misjudged"] as const)
      expect(
        injector.offer(
          hit(
            "E-0007",
            { status: excluded === "wontfix" ? "wontfix" : "open" },
            {
              injectable: false,
              excluded,
            },
          ),
        ),
      ).toBeUndefined();
    // Silence spent no budget.
    expect(injector.offer(hit("E-0008"))).toBeDefined();
  });

  it("emits a no-fix hit without touching trust", () => {
    const injector = new Injector();
    const notice = injector.offer(hit("E-0007", { fix: "" }));
    expect(notice?.kind).toBe("no-fix");
    expect(injector.trust.snapshot()).toEqual({ entries: {} });
  });

  it("applies the caps: 1 per step, 3 per turn", () => {
    const injector = new Injector({ mode: "always" });
    injector.beginTurn();
    expect(injector.offer(hit("E-1"))).toBeDefined();
    expect(injector.offer(miss("E-2"))).toBeUndefined();
    const later = ["E-3", "E-4", "E-5"].map((id) => {
      injector.beginStep();
      return injector.offer(hit(id)) !== undefined;
    });
    expect(later).toEqual([true, true, false]);
  });

  it("lets a fixed entry speak once per session", () => {
    const injector = new Injector();
    const fixed = () => hit("E-0007", { status: "fixed" });
    expect(injector.offer(fixed())).toBeDefined();
    injector.beginTurn();
    expect(injector.offer(fixed())).toBeUndefined();
  });

  it("speaks at most twice per ID per session", () => {
    const injector = new Injector();
    const spoken = [1, 2, 3].map(() => {
      injector.beginTurn();
      return injector.offer(hit()) !== undefined;
    });
    expect(spoken).toEqual([true, true, false]);
  });

  it("turns doubtful after a recurrence in the turn, then stops at two", () => {
    // One trust store outlives the sessions, as state.json will.
    const trust = new FixTrust();
    const session = () => new Injector({ trust });

    const first = session();
    first.beginTurn();
    expect(first.offer(hit())?.kind).toBe("hit");
    first.beginStep();
    // Same error again in the same turn: the fix did not hold.
    const second = first.offer(hit());
    expect(second?.kind).toBe("doubted");
    expect(second?.text.endsWith(WORDING.doubted)).toBe(true);
    expect(second?.text).not.toContain(WORDING.hit);
    first.beginStep();
    // A second recurrence: suppressed on this machine.
    expect(first.offer(hit())).toBeUndefined();
    expect(trust.snapshot().entries["E-0007"]).toMatchObject({
      injected: 2,
      recurredAfterInject: 2,
      succeeded: 0,
    });

    const next = session();
    next.beginTurn();
    expect(next.offer(hit())).toBeUndefined();
    // Another entry is unaffected.
    expect(next.offer(hit("E-0008"))?.kind).toBe("hit");
  });

  it("does not count a recurrence across turns", () => {
    const injector = new Injector();
    injector.beginTurn();
    injector.offer(hit());
    injector.beginTurn();
    expect(injector.offer(hit())?.kind).toBe("hit");
  });

  it("a recurring near hit is doubtful as well as approximate", () => {
    const injector = new Injector();
    injector.offer(near());
    injector.beginStep();
    const notice = injector.offer(near());
    expect(notice?.kind).toBe("doubted");
    expect(
      notice?.text.endsWith(`${WORDING.approximate} ${WORDING.doubted}`),
    ).toBe(true);
  });

  it("every notice it emits is inside the caps", () => {
    const injector = new Injector({ mode: "always" });
    const events = [
      hit("E-1", { fix: cjk(40), trigger: cjk(20) }),
      near("E-2", { fix: "x ".repeat(400) }),
      miss("E-3"),
    ];
    for (const event of events) {
      injector.beginStep();
      const notice = injector.offer(event);
      expect(notice).toBeDefined();
      expect(withinCaps(notice!.text)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T13: scoped trust, observe(), the digest and the standing section

describe("fix trust scopes, through the injector", () => {
  it("an observed hit is not counted again when it is offered", () => {
    const trust = new FixTrust();
    const injector = new Injector({ trust, scope: "s" });
    const event = hit() as Extract<NoticeEvent, { kind: "hit" }>;
    expect(injector.offer(event)?.kind).toBe("hit");
    injector.caps.beginStep();
    injector.observe(event.hit);
    expect(injector.offer(event, true)?.kind).toBe("doubted");
    expect(trust.record("E-0007", FIX)?.recurredAfterInject).toBe(1);
  });
});
