// Ported from dsh-errkb, tests/resolve-detect.test.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
import { describe, expect, it } from "vitest";
import { withinCaps } from "../src/notice";
import {
  CAPTURE_FIX_MODES,
  MAX_WATCHES,
  RESOLUTION_WINDOW_TURNS,
  ResolutionTracker,
  askFixText,
  callOutcome,
} from "../src/resolve-detect";
import type { ResolutionSnapshot } from "../src/resolve-detect";

// ---------------------------------------------------------------------------
// The prompt

describe("askFixText", () => {
  it("is the exact one-shot wording, inside the notice caps", () => {
    expect(askFixText("E-0011")).toBe(
      "[antibody] E-0011 looks resolved. Record the fix with antibody_record in one sentence so it can be reused.",
    );
    expect(withinCaps(askFixText("E-0011"))).toBe(true);
  });

  it("documents both captureFix modes, prompt-once first", () => {
    expect(CAPTURE_FIX_MODES).toEqual(["prompt-once", "off"]);
  });
});

// ---------------------------------------------------------------------------
// Keys

describe("callOutcome", () => {
  it("a tool failure is keyed by the tool", () => {
    expect(
      callOutcome({
        toolName: "shell",
        command: "pnpm tsc",
        isError: true,
        text: "",
      }),
    ).toEqual({ ok: false, key: "tool:shell" });
  });

  it("a non-zero exit is keyed by its command, whitespace collapsed", () => {
    expect(
      callOutcome({
        toolName: "shell",
        command: "  pnpm\n tsc ",
        isError: false,
        text: "boom\n[exit code: 2]",
      }),
    ).toEqual({ ok: false, key: "command:pnpm tsc" });
  });

  it("a non-zero exit without a command is keyed by the tool", () => {
    for (const command of [undefined, "  "])
      expect(
        callOutcome({
          toolName: "shell",
          ...(command === undefined ? {} : { command }),
          isError: false,
          text: "[exit code: 1]",
        }),
      ).toEqual({ ok: false, key: "tool:shell" });
  });

  it("the last exit marker decides", () => {
    expect(
      callOutcome({
        toolName: "shell",
        command: "make",
        isError: false,
        text: "[exit code: 1]\nretrying\n[exit code: 0]",
      }).ok,
    ).toBe(true);
  });

  it("a success answers for its tool and its command", () => {
    expect(
      callOutcome({
        toolName: "shell",
        command: "pnpm tsc",
        isError: false,
        text: "done\n[exit code: 0]",
      }),
    ).toEqual({ ok: true, keys: ["tool:shell", "command:pnpm tsc"] });
    expect(
      callOutcome({ toolName: "read", isError: false, text: "contents" }),
    ).toEqual({ ok: true, keys: ["tool:read"] });
  });
});

// ---------------------------------------------------------------------------
// The tracker

describe("ResolutionTracker: the window", () => {
  it(`is the rest of the turn plus ${RESOLUTION_WINDOW_TURNS} more`, () => {
    expect(RESOLUTION_WINDOW_TURNS).toBe(1);
  });

  it("a success later in the same turn resolves", () => {
    const t = new ResolutionTracker();
    t.beginTurn();
    t.occurred("E-0001", "tool:a");
    expect(t.succeeded(["tool:a"])).toEqual(["E-0001"]);
    // Once only: the watch is gone.
    expect(t.succeeded(["tool:a"])).toEqual([]);
    expect(t.watched()).toEqual([]);
  });

  it("a success in the next turn resolves", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", "tool:a");
    t.beginTurn();
    expect(t.succeeded(["tool:a"])).toEqual(["E-0001"]);
  });

  it("two turns later the watch has lapsed", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", "tool:a");
    t.beginTurn();
    t.beginTurn();
    expect(t.watched()).toEqual([]);
    expect(t.succeeded(["tool:a"])).toEqual([]);
  });

  it("an explicit turn is checked against both edges", () => {
    const t = new ResolutionTracker();
    t.beginTurn();
    t.beginTurn();
    t.occurred("E-0001", "tool:a", 1);
    // Before the occurrence: nothing.
    expect(t.succeeded(["tool:a"], 0)).toEqual([]);
    // Past the window, though the watch has not been swept yet: nothing.
    expect(t.succeeded(["tool:a"], 3)).toEqual([]);
    expect(t.succeeded(["tool:a"], 2)).toEqual(["E-0001"]);
  });

  it("open() says whether something from a turn is still inside it", () => {
    const t = new ResolutionTracker();
    expect(t.turn).toBe(0);
    t.beginTurn();
    expect(t.open(0)).toBe(true);
    expect(t.open(1)).toBe(true);
    t.beginTurn();
    expect(t.open(0)).toBe(false);
  });

  it("only the matching key resolves", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", "command:pnpm tsc");
    t.occurred("E-0002", "tool:read");
    expect(t.succeeded(["tool:shell", "command:pnpm test"])).toEqual([]);
    expect(t.succeeded(["tool:shell", "command:pnpm tsc"])).toEqual(["E-0001"]);
    expect(t.watched()).toEqual(["E-0002"]);
  });

  it("one success resolves every entry watched under its key", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", "tool:a");
    t.occurred("E-0002", "tool:a");
    expect(t.succeeded(["tool:a"])).toEqual(["E-0001", "E-0002"]);
  });
});

describe("ResolutionTracker: recurrence", () => {
  it("a recurrence on another key cancels the resolution on the first", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", "command:pnpm tsc");
    t.occurred("E-0001", "command:npx tsc");
    expect(t.succeeded(["command:pnpm tsc"])).toEqual([]);
    expect(t.succeeded(["command:npx tsc"])).toEqual(["E-0001"]);
  });

  it("a recurrence restarts the window", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", "tool:a");
    t.beginTurn();
    t.occurred("E-0001", "tool:a");
    t.beginTurn();
    expect(t.watched()).toEqual(["E-0001"]);
    expect(t.succeeded(["tool:a"])).toEqual(["E-0001"]);
  });

  it(`keeps at most ${MAX_WATCHES} watches, the least recently recorded going first`, () => {
    const t = new ResolutionTracker();
    for (let i = 0; i <= MAX_WATCHES; i++) t.occurred(`E-${i}`, "tool:a");
    // E-0 is refreshed by a recurrence before the overflow evicts it.
    const u = new ResolutionTracker();
    for (let i = 0; i < MAX_WATCHES; i++) u.occurred(`E-${i}`, "tool:a");
    u.occurred("E-0", "tool:a");
    u.occurred("E-new", "tool:a");
    expect(t.watched()).toHaveLength(MAX_WATCHES);
    expect(t.watched()).not.toContain("E-0");
    expect(u.watched()).toContain("E-0");
    expect(u.watched()).not.toContain("E-1");
  });
});

describe("ResolutionTracker: moving past", () => {
  const test = "command:npm test";

  it("resolves what a command was watched for once it fails on something else", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", test);
    t.occurred("E-0003", "command:npm run build");
    expect(t.movedPast("E-0002", test)).toEqual(["E-0001"]);
    expect(t.watched()).toEqual(["E-0003"]);
  });

  it("is not a move past when the same error comes back", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", test);
    expect(t.movedPast("E-0001", test)).toEqual([]);
    expect(t.watched()).toEqual(["E-0001"]);
  });

  it("says nothing for a tool's key", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", "tool:Read");
    expect(t.movedPast("E-0002", "tool:Read")).toEqual([]);
    expect(t.watched()).toEqual(["E-0001"]);
  });

  it("keeps to the window", () => {
    const t = new ResolutionTracker();
    t.occurred("E-0001", test, 0);
    t.occurred("E-0002", test, 3);
    expect(t.movedPast("E-0009", test, 2)).toEqual([]);
    expect(t.movedPast("E-0009", test, 4)).toEqual(["E-0002"]);
  });
});

describe("ResolutionTracker: the prompt is taken once", () => {
  it("ask() is true the first time per entry, and never again", () => {
    const t = new ResolutionTracker();
    expect(t.hasAsked("E-0001")).toBe(false);
    expect(t.ask("E-0001")).toBe(true);
    expect(t.hasAsked("E-0001")).toBe(true);
    expect(t.ask("E-0001")).toBe(false);
    expect(t.ask("E-0002")).toBe(true);
  });
});

describe("ResolutionTracker snapshots", () => {
  it("carries watches, the turn and the asked set to the next process", () => {
    const first = new ResolutionTracker();
    first.beginTurn();
    first.occurred("E-0001", "command:pnpm test");
    first.occurred("E-0002", "tool:Read");
    first.ask("E-0002");
    const next = ResolutionTracker.restore(
      JSON.parse(JSON.stringify(first.snapshot())),
    );
    expect(next.turn).toBe(1);
    expect(next.watched()).toEqual(["E-0001", "E-0002"]);
    expect(next.ask("E-0002")).toBe(false);
    expect(next.succeeded(["command:pnpm test"])).toEqual(["E-0001"]);
  });

  it("starts fresh without a snapshot", () => {
    expect(ResolutionTracker.restore(undefined).snapshot()).toEqual({
      turn: 0,
      watches: [],
      asked: [],
    });
  });

  it("drops malformed watches and keeps the newest MAX_WATCHES", () => {
    const watches = [
      { id: "bad-turn", key: "k", turn: -1 },
      { id: 7, key: "k", turn: 0 },
      null,
      ...Array.from({ length: MAX_WATCHES }, (_, n) => ({
        id: `E-${n}`,
        key: "k",
        turn: 0,
      })),
    ] as unknown as ResolutionSnapshot["watches"];
    const tracker = ResolutionTracker.restore({
      turn: "3" as unknown as number,
      watches,
      asked: ["E-1", 5 as unknown as string],
    });
    expect(tracker.turn).toBe(0);
    expect(tracker.watched()).toHaveLength(MAX_WATCHES);
    expect(tracker.watched()[0]).toBe("E-0");
    expect(tracker.snapshot().asked).toEqual(["E-1"]);
    expect(
      ResolutionTracker.restore({
        watches: {} as unknown as ResolutionSnapshot["watches"],
      }).watched(),
    ).toEqual([]);
  });
});
