// Ported from dsh-errkb, tests/inject.test.ts (MIT, Copyright (c) 2026
// jingchangzhao-gif; see NOTICE): the cases for fix trust.
import { describe, expect, it } from "vitest";
import { FixTrust, fixSig, memoryTrustStore, trustLevel } from "../src/trust";
import type { TrustState } from "../src/trust";

const FIX =
  "close the locking process and re-run; if it persists, use pnpm install --config.node-linker=hoisted.";

describe("fix trust", () => {
  it("trustLevel: trusted, doubted after 1, suppressed after 2 with no success", () => {
    const r = (recurredAfterInject: number, succeeded = 0) => ({
      injected: 3,
      recurredAfterInject,
      succeeded,
      fixSig: "x",
    });
    expect(trustLevel(undefined)).toBe("trusted");
    expect(trustLevel(r(0))).toBe("trusted");
    expect(trustLevel(r(1))).toBe("doubted");
    expect(trustLevel(r(2))).toBe("suppressed");
    expect(trustLevel(r(5, 1))).toBe("doubted");
  });

  it("fixSig ignores whitespace and changes with the fix", () => {
    expect(fixSig("a  b\n")).toBe(fixSig("a b"));
    expect(fixSig("a b")).not.toBe(fixSig("a c"));
    expect(fixSig("a")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("counts a recurrence only after an injection in the same turn", () => {
    const trust = new FixTrust();
    trust.seen("E-0007", FIX);
    expect(trust.record("E-0007", FIX)).toBeUndefined();
    trust.injected("E-0007", FIX);
    trust.beginTurn();
    trust.seen("E-0007", FIX);
    expect(trust.record("E-0007", FIX)).toMatchObject({
      injected: 1,
      recurredAfterInject: 0,
    });
    trust.injected("E-0007", FIX);
    trust.seen("E-0007", FIX);
    trust.seen("E-0007", FIX);
    expect(trust.record("E-0007", FIX)).toMatchObject({
      injected: 2,
      recurredAfterInject: 1,
    });
    expect(trust.level("E-0007", FIX)).toBe("doubted");
  });

  it("starts over when the fix text is edited", () => {
    const trust = new FixTrust();
    trust.injected("E-0007", FIX);
    trust.seen("E-0007", FIX);
    expect(trust.level("E-0007", FIX)).toBe("doubted");
    expect(trust.level("E-0007", "a better fix")).toBe("trusted");
    trust.injected("E-0007", "a better fix");
    expect(trust.snapshot().entries["E-0007"]).toEqual({
      injected: 1,
      recurredAfterInject: 0,
      succeeded: 0,
      fixSig: fixSig("a better fix"),
    });
  });

  it("a success lifts suppression", () => {
    const trust = new FixTrust();
    trust.succeeded("E-0007", FIX);
    expect(trust.record("E-0007", FIX)).toBeUndefined();
    for (let i = 0; i < 2; i++) {
      trust.injected("E-0007", FIX);
      trust.seen("E-0007", FIX);
    }
    expect(trust.level("E-0007", FIX)).toBe("suppressed");
    trust.succeeded("E-0007", FIX);
    expect(trust.level("E-0007", FIX)).toBe("doubted");
  });

  it("keeps plain, serializable state behind its store", () => {
    const store = memoryTrustStore();
    const trust = new FixTrust(store);
    trust.injected("E-0007", FIX);
    trust.seen("E-0007", FIX);
    const saved: TrustState = store.load();
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    expect(saved).toEqual(trust.snapshot());
    expect(new FixTrust(store).level("E-0007", FIX)).toBe("doubted");
  });

  it("memoryTrustStore copies in and out", () => {
    const initial: TrustState = { entries: {} };
    const store = memoryTrustStore(initial);
    initial.entries["E-1"] = {
      injected: 1,
      recurredAfterInject: 0,
      succeeded: 0,
      fixSig: "x",
    };
    expect(store.load()).toEqual({ entries: {} });
    const loaded = store.load();
    loaded.entries["E-2"] = initial.entries["E-1"];
    expect(store.load()).toEqual({ entries: {} });
    expect(memoryTrustStore().load()).toEqual({ entries: {} });
  });
});

describe("fix trust: a store that loads asynchronously (state.json)", () => {
  const record = (fix: string, recurred = 0) => ({
    injected: 1,
    recurredAfterInject: recurred,
    succeeded: 0,
    fixSig: fixSig(fix),
  });

  it("saved records join once read; one that changed meanwhile is kept", async () => {
    let finish: (state: TrustState | undefined) => void = () => undefined;
    const saves: TrustState[] = [];
    const trust = new FixTrust({
      load: () => ({ entries: {} }),
      save: (state) => saves.push(structuredClone(state)),
      loaded: new Promise((resolve) => {
        finish = resolve;
      }),
    });
    // Before the read lands, this process injects E-0001's fix.
    trust.injected("E-0001", "fresh");
    finish({
      entries: { "E-0001": record("stale", 2), "E-0002": record("b", 2) },
    });
    await trust.ready;
    expect(trust.record("E-0001", "fresh")).toMatchObject({ injected: 1 });
    expect(trust.level("E-0002", "b")).toBe("suppressed");
    expect(saves).toHaveLength(1);
  });

  it("nothing saved: the state stays as load() gave it", async () => {
    const trust = new FixTrust({
      load: () => ({ entries: { "E-0001": record("a") } }),
      save: () => undefined,
      loaded: Promise.resolve(undefined),
    });
    await trust.ready;
    expect(trust.snapshot().entries).toEqual({ "E-0001": record("a") });
  });
});

describe("fix trust scopes (T13)", () => {
  it("a recurrence counts only in the scope that injected the fix", () => {
    const trust = new FixTrust();
    trust.injected("E-0007", FIX, "a");
    trust.seen("E-0007", FIX, "b");
    expect(trust.record("E-0007", FIX)?.recurredAfterInject).toBe(0);
    trust.beginTurn("b");
    trust.seen("E-0007", FIX, "a");
    expect(trust.record("E-0007", FIX)?.recurredAfterInject).toBe(1);
  });

  it("a new turn in one scope leaves another scope's injections alone", () => {
    const trust = new FixTrust();
    trust.injected("E-0007", FIX, "a");
    trust.injected("E-0008", FIX, "b");
    trust.beginTurn("a");
    trust.seen("E-0007", FIX, "a");
    trust.seen("E-0008", FIX, "b");
    expect(trust.record("E-0007", FIX)?.recurredAfterInject).toBe(0);
    expect(trust.record("E-0008", FIX)?.recurredAfterInject).toBe(1);
  });
});

describe("fix trust across hook calls", () => {
  it("carries a turn's injections into the next process of the same turn", () => {
    const first = new FixTrust();
    first.injected("E-0007", FIX, "s-a");
    first.injected("E-0008", FIX, "s-b");
    expect(first.injectedInTurn("s-a")).toEqual(["E-0007"]);

    const next = new FixTrust(memoryTrustStore(first.snapshot()));
    next.restoreTurn(first.injectedInTurn("s-a"), "s-a");
    next.seen("E-0007", FIX, "s-a");
    expect(next.record("E-0007", FIX)?.recurredAfterInject).toBe(1);
  });

  it("forgets a scope's injections once its turn ends, and ignores junk", () => {
    const trust = new FixTrust();
    trust.restoreTurn(["E-0001", 5 as unknown as string], "s");
    expect(trust.injectedInTurn("s")).toEqual(["E-0001"]);
    trust.beginTurn("s");
    expect(trust.injectedInTurn("s")).toEqual([]);
    expect(trust.injectedInTurn()).toEqual([]);
  });
});
