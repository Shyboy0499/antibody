import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureInput } from "../src/capture";
import { readEventsFrom } from "../src/events";
import { createFleet } from "../src/fleet";
import type { FleetDeps, FleetOptions } from "../src/fleet";
import { parseClaims } from "../src/claims";
import { nodeStoreFs } from "../src/store";
import type { StoreClock, StoreFs } from "../src/store";
import { filesIn } from "../src/paths";
import type { ToolCall } from "../src/resolve-detect";
import { parseState } from "../src/state";
import { REVIEW_ALL } from "../src/review";
import { createStore, parseDocument } from "../src/store";

// Every call builds a new engine, as every hook call is a new process.
const MESSAGE = "ENOENT: no such file or directory, open '.env'";
const capture: CaptureInput = {
  kind: "tool",
  toolName: "Read",
  isError: true,
  message: MESSAGE,
};
const call: ToolCall = { toolName: "Read", isError: true, text: MESSAGE };
const FIX = "Copy .env from the main checkout into this worktree.";

let memory: string;
const fail = (session: string, options: Partial<FleetOptions> = {}) =>
  createFleet(memory, `agent-${session}`, session, options).failure(
    capture,
    call,
  );
const events = async () =>
  (await readEventsFrom(filesIn(memory).events)).events;
const recordFix = (status: "fixed" | "open" = "fixed") =>
  createStore(filesIn(memory)).update("E-0001", { fix: FIX, status });

beforeEach(async () => {
  memory = join(await mkdtemp(join(tmpdir(), "antibody-fleet-")), "memory");
});

afterEach(async () => {
  await rm(join(memory, ".."), { recursive: true, force: true });
});

describe("fleet: failures", () => {
  it("records a new error as an entry, without a notice", async () => {
    expect(await fail("s-a")).toEqual([]);
    const document = parseDocument(
      await readFile(filesIn(memory).errors, "utf8"),
    );
    expect(document.blocks.map((b) => b.entry.id)).toEqual(["E-0001"]);
    expect(document.blocks[0]!.entry.title).toContain("ENOENT");
    expect((await events()).map((e) => [e.kind, e.agent, e.id])).toEqual([
      ["miss", "agent-s-a", "E-0001"],
      ["claim", "agent-s-a", "E-0001"],
    ]);
  });

  it("announces a miss when inject is always", async () => {
    expect(await fail("s-a", { inject: "always" })).toEqual([
      "[antibody] recorded as E-0001 (no fix yet).",
    ]);
  });

  it("counts a repeat in state.json and says no fix is recorded yet", async () => {
    await fail("s-a");
    const notices = await fail("s-a");
    expect(notices).toEqual([
      "[antibody] E-0001 seen before (2 hits), no fix recorded yet.",
    ]);
    const state = parseState(await readFile(filesIn(memory).state, "utf8"));
    expect(state?.entries["E-0001"]?.hits).toBe(1);
    expect((await events()).map((e) => e.kind)).toEqual([
      "miss",
      "claim",
      "hit",
      "notice",
    ]);
  });

  it("hands another agent the recorded fix", async () => {
    await fail("s-a");
    await recordFix();
    const [notice] = await fail("s-b");
    expect(notice).toContain("[antibody] E-0001 known (2 hits)");
    expect(notice).toContain(`fix: ${FIX}`);
    expect(notice).toContain("Known fix: try this first");
    const logged = (await events()).find((e) => e.kind === "notice");
    expect(logged?.tokens).toBeGreaterThan(0);
    expect(logged?.notice).toBe("hit");
  });

  it("tells each session about a fixed entry once", async () => {
    await fail("s-a");
    await recordFix();
    expect(await fail("s-b")).toHaveLength(1);
    expect(await fail("s-b")).toEqual([]);
    expect(await fail("s-c")).toHaveLength(1);
  });

  it("carries trust and budgets from one hook call to the next", async () => {
    await fail("s-a");
    await recordFix("open");
    const first = await fail("s-b");
    const second = await fail("s-b");
    const third = await fail("s-b");
    expect(first[0]).toContain("Known fix");
    expect(second[0]).toContain("This fix failed here last time");
    expect(third).toEqual([]);
    const state = parseState(await readFile(filesIn(memory).state, "utf8"));
    // The error came back after both injections in the same turn: two
    // recurrences with no success, so the fix is now suppressed for this machine.
    expect(state?.trust["E-0001"]).toMatchObject({
      injected: 2,
      recurredAfterInject: 2,
    });
  });

  it("watches the failed call so a later success can resolve it", async () => {
    await fail("s-a");
    const session = JSON.parse(
      await readFile(join(memory, "sessions", "s-a.json"), "utf8"),
    );
    expect(session.resolution.watches).toEqual([
      { id: "E-0001", key: "tool:Read", turn: 0 },
    ]);
  });

  it("still records and counts when inject is off, but says nothing", async () => {
    await fail("s-a", { inject: "off" });
    await recordFix();
    expect(await fail("s-b", { inject: "off" })).toEqual([]);
    expect((await events()).map((e) => e.kind)).toEqual([
      "miss",
      "claim",
      "hit",
    ]);
  });

  it("ignores what is not a failure worth recording", async () => {
    const ok: CaptureInput = {
      kind: "command",
      toolName: "Bash",
      text: "done\n[exit code: 0]",
    };
    const okCall: ToolCall = {
      toolName: "Bash",
      isError: false,
      text: "done\n[exit code: 0]",
    };
    expect(await createFleet(memory, "a", "s-a").failure(ok, okCall)).toEqual(
      [],
    );
    expect(await events()).toEqual([]);
  });
});

describe("fleet: claims", () => {
  let now: number;
  const clock: StoreClock = {
    now: () => new Date(now),
    sleep: (ms) =>
      new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    random: Math.random,
  };
  const deps: FleetDeps = { fs: nodeStoreFs(), clock };
  const failAt = (session: string, options: Partial<FleetOptions> = {}) =>
    createFleet(memory, `agent-${session}`, session, options, deps).failure(
      capture,
      call,
    );
  const claimsFile = async () =>
    parseClaims(await readFile(filesIn(memory).claims, "utf8"))!.claims;

  beforeEach(() => {
    now = Date.parse("2026-10-05T10:00:00.000Z");
  });

  it("gives the first agent to meet a new error its claim", async () => {
    await failAt("s-a");
    const [claim] = Object.values(await claimsFile());
    expect(claim).toMatchObject({ agent: "agent-s-a", session: "s-a" });
    const document = parseDocument(
      await readFile(filesIn(memory).errors, "utf8"),
    );
    expect(claim!.id).toBe(document.blocks[0]!.entry.fingerprint);
  });

  it("tells a second agent who is diagnosing it, and remembers to wait", async () => {
    await failAt("s-a");
    now += 40_000;
    expect(await failAt("s-b")).toEqual([
      "[antibody] E-0001: agent-s-a has been diagnosing this for 40 s. Its fix will be passed to you when it is recorded.",
    ]);
    const session = JSON.parse(
      await readFile(join(memory, "sessions", "s-b.json"), "utf8"),
    );
    expect(session.holding).toEqual([Object.keys(await claimsFile())[0]]);
    expect((await events()).map((e) => [e.kind, e.notice])).toEqual([
      ["miss", undefined],
      ["claim", undefined],
      ["hit", undefined],
      ["hold", undefined],
      ["notice", "hold"],
    ]);
  });

  it("hints at most twice per session, but keeps waiting", async () => {
    await failAt("s-a");
    const hints = [
      await failAt("s-b"),
      await failAt("s-b"),
      await failAt("s-b"),
    ];
    expect(hints.map((h) => h.length)).toEqual([1, 1, 0]);
    expect((await events()).filter((e) => e.kind === "hold")).toHaveLength(3);
  });

  it("lets the next agent take over a claim whose time ran out", async () => {
    await failAt("s-a", { claimTtlMs: 1_000 });
    now += 1_000;
    expect(await failAt("s-b", { claimTtlMs: 1_000 })).toEqual([
      "[antibody] E-0001 seen before (2 hits), no fix recorded yet.",
    ]);
    expect(Object.values(await claimsFile())[0]).toMatchObject({
      agent: "agent-s-b",
    });
    expect((await events()).map((e) => [e.kind, e.notice])).toEqual([
      ["miss", undefined],
      ["claim", undefined],
      ["hit", undefined],
      ["claim", undefined],
      ["notice", "no-fix"],
    ]);
  });

  it("renews the holder's own claim without logging it again", async () => {
    await failAt("s-a");
    now += 60_000;
    await failAt("s-a");
    expect((await events()).filter((e) => e.kind === "claim")).toHaveLength(1);
    expect(Object.values(await claimsFile())[0]!.expires).toBe(
      new Date(now + 10 * 60 * 1000).toISOString(),
    );
  });

  it("writes one entry when two agents meet a new error at the same moment", async () => {
    const [a, b] = await Promise.all([failAt("s-a"), failAt("s-b")]);
    const document = parseDocument(
      await readFile(filesIn(memory).errors, "utf8"),
    );
    expect(document.blocks).toHaveLength(1);
    const hint = [...a, ...b];
    expect(hint).toHaveLength(1);
    expect(hint[0]).toMatch(/has been diagnosing this for 0 s/);
  });
});

describe("fleet: deliveries", () => {
  let now: number;
  const clock: StoreClock = {
    now: () => new Date(now),
    sleep: (ms) =>
      new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    random: Math.random,
  };
  const deps: FleetDeps = { fs: nodeStoreFs(), clock };
  const fleet = (session: string, options: Partial<FleetOptions> = {}) =>
    createFleet(memory, `agent-${session}`, session, options, deps);
  const holding = async (session: string) =>
    JSON.parse(
      await readFile(join(memory, "sessions", `${session}.json`), "utf8"),
    ).holding;
  const other: CaptureInput = {
    kind: "tool",
    toolName: "Bash",
    isError: true,
    message: "fatal: 'main' is already checked out at '/w/a'",
  };
  const otherCall: ToolCall = {
    toolName: "Bash",
    isError: true,
    text: other.message,
  };

  beforeEach(async () => {
    now = Date.parse("2026-10-05T10:00:00.000Z");
    await fleet("s-a").failure(capture, call);
    await fleet("s-b").failure(capture, call);
  });

  it("passes the fix to the waiting agent once it is recorded, once", async () => {
    expect(await fleet("s-b").poll()).toEqual([]);
    await recordFix();
    const [notice] = await fleet("s-b").poll();
    expect(notice).toContain(`fix: ${FIX}`);
    expect(await holding("s-b")).toEqual([]);
    expect(await fleet("s-b").poll()).toEqual([]);
  });

  it("keeps waiting while the claim is live and there is no fix", async () => {
    const before = await holding("s-b");
    expect(await fleet("s-b").poll()).toEqual([]);
    expect(await holding("s-b")).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it("stops waiting when the claim lapses without a fix", async () => {
    now += 10 * 60 * 1000;
    expect(await fleet("s-b").poll()).toEqual([]);
    expect(await holding("s-b")).toEqual([]);
  });

  it("delivers alongside an unrelated failure in the same hook call", async () => {
    await recordFix();
    const notices = await fleet("s-b").failure(other, otherCall);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`fix: ${FIX}`);
    expect(await holding("s-b")).toEqual([]);
  });

  it("lets a hit on the awaited entry itself end the wait", async () => {
    await recordFix();
    const [notice] = await fleet("s-b").failure(capture, call);
    expect(notice).toContain(`fix: ${FIX}`);
    expect(await holding("s-b")).toEqual([]);
    expect(await fleet("s-b").poll()).toEqual([]);
  });

  it("tries again on the next call when the step's budget is spent", async () => {
    await recordFix("open");
    await fleet("s-a").failure(other, otherCall);
    await createStore(filesIn(memory)).update("E-0002", {
      fix: "Use a branch of your own.",
    });
    // s-b waits for E-0001; its own failure on E-0002 takes the step's one notice.
    const first = await fleet("s-b").failure(other, otherCall);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("Use a branch of your own.");
    expect(await holding("s-b")).toHaveLength(1);
    const [later] = await fleet("s-b").poll();
    expect(later).toContain(`fix: ${FIX}`);
  });

  it("delivers the promised fix even once the turn's budget is spent", async () => {
    // s-b was told once in beforeEach; a second hint and a fix for another
    // error spend the rest of its turn's three notices.
    expect(await fleet("s-b").failure(capture, call)).toHaveLength(1);
    await fleet("s-c").failure(other, otherCall);
    await createStore(filesIn(memory)).update("E-0002", {
      fix: "Use a branch of your own.",
    });
    expect(await fleet("s-b").failure(other, otherCall)).toHaveLength(1);
    await recordFix();
    const [notice] = await fleet("s-b").poll();
    expect(notice).toContain(`fix: ${FIX}`);
    expect(await holding("s-b")).toEqual([]);
  });

  it("hands the promised fix to a hit on the awaited entry once the turn's budget is spent", async () => {
    expect(await fleet("s-b").failure(capture, call)).toHaveLength(1);
    await fleet("s-c").failure(other, otherCall);
    await createStore(filesIn(memory)).update("E-0002", {
      fix: "Use a branch of your own.",
    });
    expect(await fleet("s-b").failure(other, otherCall)).toHaveLength(1);
    await recordFix();
    const [notice] = await fleet("s-b").failure(capture, call);
    expect(notice).toContain(`fix: ${FIX}`);
  });

  it("does nothing for a session that waits for nothing", async () => {
    expect(await fleet("s-c").poll()).toEqual([]);
  });
});

describe("fleet: successes", () => {
  const ok: ToolCall = {
    toolName: "Read",
    isError: false,
    text: "API_URL=...",
  };
  const elsewhere: ToolCall = { toolName: "Grep", isError: false, text: "" };
  const succeed = (session: string, c: ToolCall = ok) =>
    createFleet(memory, `agent-${session}`, session).success(c);

  it("asks the agent that got past an unfixed error to record the fix, once", async () => {
    await fail("s-a");
    expect(await succeed("s-a")).toEqual([
      "[antibody] E-0001 looks resolved. Record the fix with antibody_record in one sentence so it can be reused.",
    ]);
    await fail("s-a");
    expect(await succeed("s-a")).toEqual([]);
    expect((await events()).filter((e) => e.kind === "resolve")).toHaveLength(
      2,
    );
  });

  describe("two entries got past in one call", () => {
    const other: CaptureInput = {
      kind: "tool",
      toolName: "Read",
      isError: true,
      message: "EACCES: permission denied, open 'secrets.json'",
    };
    const otherCall: ToolCall = {
      toolName: "Read",
      isError: true,
      text: other.message,
    };
    const fleet = () => createFleet(memory, "agent-s-a", "s-a");
    const asking = async () =>
      JSON.parse(await readFile(join(memory, "sessions", "s-a.json"), "utf8"))
        .asking;

    beforeEach(async () => {
      await fail("s-a");
      await fleet().failure(other, otherCall);
    });

    it("asks for the second fix on the next call, not never", async () => {
      // One notice per call: the first ask goes now, the second waits.
      expect(await succeed("s-a")).toEqual([
        "[antibody] E-0001 looks resolved. Record the fix with antibody_record in one sentence so it can be reused.",
      ]);
      expect(await asking()).toEqual(["E-0002"]);
      expect(await fleet().poll()).toEqual([
        "[antibody] E-0002 looks resolved. Record the fix with antibody_record in one sentence so it can be reused.",
      ]);
      expect(await asking()).toEqual([]);
      expect(await fleet().poll()).toEqual([]);
    });

    it("asks when a prompt arrives, too", async () => {
      await succeed("s-a");
      expect(await fleet().beginTurn()).toEqual([
        "[antibody] E-0002 looks resolved. Record the fix with antibody_record in one sentence so it can be reused.",
      ]);
    });

    it("drops an ask whose fix was recorded meanwhile", async () => {
      await succeed("s-a");
      await createStore(filesIn(memory)).update("E-0002", {
        fix: FIX,
        status: "fixed",
      });
      expect(await fleet().poll()).toEqual([]);
      expect(await asking()).toEqual([]);
    });

    it("drops an ask whose entry is gone", async () => {
      await succeed("s-a");
      await createStore(filesIn(memory)).archive("E-0002", "test");
      expect(await fleet().poll()).toEqual([]);
      expect(await asking()).toEqual([]);
    });
  });

  describe("a command that fails on something else", () => {
    const run = (output: string): [CaptureInput, ToolCall] => {
      const text = `${output}\n[exit code: 1]`;
      return [
        { kind: "command", toolName: "Bash", command: "npm test", text },
        { toolName: "Bash", command: "npm test", isError: false, text },
      ];
    };
    const lockfile = run("ERR_PNPM_OUTDATED_LOCKFILE deps.lock is out of date");
    const env = run("Error: Environment variable not found: DATABASE_URL.");
    const fleet = (session: string) =>
      createFleet(memory, `agent-${session}`, session);

    it("has got past its first error, and is asked for that fix", async () => {
      expect(await fleet("s-a").failure(...lockfile)).toEqual([]);
      expect(await fleet("s-a").failure(...env)).toEqual([
        "[antibody] E-0001 looks resolved. Record the fix with antibody_record in one sentence so it can be reused.",
      ]);
      expect(
        (await events()).filter((e) => e.kind === "resolve").map((e) => e.id),
      ).toEqual(["E-0001"]);
    });

    it("has not got past an error that comes back", async () => {
      await fleet("s-a").failure(...lockfile);
      expect(await fleet("s-a").failure(...lockfile)).toEqual([
        "[antibody] E-0001 seen before (2 hits), no fix recorded yet.",
      ]);
      expect((await events()).some((e) => e.kind === "resolve")).toBe(false);
    });

    it("gives a fix that got an agent past its error its trust", async () => {
      await fleet("s-a").failure(...lockfile);
      await createStore(filesIn(memory)).update("E-0001", {
        fix: FIX,
        status: "open",
      });
      expect((await fleet("s-b").failure(...lockfile))[0]).toContain(FIX);
      await fleet("s-b").failure(...env);
      const state = parseState(await readFile(filesIn(memory).state, "utf8"));
      expect(state?.trust["E-0001"]).toMatchObject({
        injected: 1,
        succeeded: 1,
      });
    });
  });

  it("gives a fix that worked its trust", async () => {
    await fail("s-a");
    await recordFix("open");
    await fail("s-b");
    expect(await succeed("s-b")).toEqual([]);
    const state = parseState(await readFile(filesIn(memory).state, "utf8"));
    expect(state?.trust["E-0001"]).toMatchObject({ injected: 1, succeeded: 1 });
  });

  it("resolves nothing for a call on another tool, or in another session", async () => {
    await fail("s-a");
    expect(await succeed("s-a", elsewhere)).toEqual([]);
    expect(await succeed("s-b")).toEqual([]);
    expect((await events()).some((e) => e.kind === "resolve")).toBe(false);
  });

  it("ignores a call that did not succeed", async () => {
    await fail("s-a");
    const failed: ToolCall = { toolName: "Read", isError: true, text: MESSAGE };
    expect(await succeed("s-a", failed)).toEqual([]);
  });

  it("skips a watched entry that is gone from the document", async () => {
    await fail("s-a");
    await createStore(filesIn(memory)).archive("E-0001", "test");
    expect(await succeed("s-a")).toEqual([]);
  });

  it("delivers a held fix on a success, too", async () => {
    await fail("s-a");
    await fail("s-b");
    await recordFix();
    const [notice] = await succeed("s-b", elsewhere);
    expect(notice).toContain(`fix: ${FIX}`);
  });
});

describe("fleet: turns and session end", () => {
  const ok: ToolCall = { toolName: "Read", isError: false, text: "" };
  const fleet = (session: string) =>
    createFleet(memory, `agent-${session}`, session);

  it("forgets the turn's injections on a new prompt, so a fix is not doubted across turns", async () => {
    await fail("s-a");
    await recordFix("open");
    expect((await fail("s-b"))[0]).toContain("Known fix");
    await fleet("s-b").beginTurn();
    expect((await fail("s-b"))[0]).toContain("Known fix");
    const state = parseState(await readFile(filesIn(memory).state, "utf8"));
    expect(state?.trust["E-0001"]?.recurredAfterInject).toBe(0);
  });

  it("lets a watch lapse after the next turn", async () => {
    await fail("s-a");
    await fleet("s-a").beginTurn();
    await fleet("s-a").beginTurn();
    expect(await fleet("s-a").success(ok)).toEqual([]);
  });

  it("still resolves within the next turn", async () => {
    await fail("s-a");
    await fleet("s-a").beginTurn();
    expect(await fleet("s-a").success(ok)).toHaveLength(1);
  });

  it("delivers held fixes when a prompt arrives", async () => {
    await fail("s-a");
    await fail("s-b");
    await recordFix();
    const [notice] = await fleet("s-b").beginTurn();
    expect(notice).toContain(`fix: ${FIX}`);
  });

  it("releases a session's claims when it ends, so the next agent takes over", async () => {
    await fail("s-a");
    const released = await fleet("s-a").endSession();
    expect(released).toHaveLength(1);
    expect((await events()).at(-1)).toMatchObject({
      kind: "release",
      id: released[0],
    });
    expect(await readFile(filesIn(memory).claims, "utf8")).not.toContain("s-a");
    await expect(
      readFile(join(memory, "sessions", "s-a.json"), "utf8"),
    ).rejects.toThrow();
    expect(await fail("s-b")).toEqual([
      "[antibody] E-0001 seen before (2 hits), no fix recorded yet.",
    ]);
  });

  it("ends a session that never wrote anything", async () => {
    expect(await fleet("s-z").endSession()).toEqual([]);
  });
});

describe("fleet: recording a fix", () => {
  const fleet = (session: string) =>
    createFleet(memory, `agent-${session}`, session);

  it("stores the fix, releases the claim and logs both", async () => {
    await fail("s-a");
    const entry = await fleet("s-a").recordFix("E-0001", `  ${FIX}\n`);
    expect(entry).toMatchObject({ id: "E-0001", fix: FIX, status: "fixed" });
    expect(await readFile(filesIn(memory).claims, "utf8")).not.toContain(
      "agent-s-a",
    );
    expect((await events()).slice(-2).map((e) => [e.kind, e.agent])).toEqual([
      ["fix", "agent-s-a"],
      ["release", "agent-s-a"],
    ]);
  });

  it("hands the fix to the agent that was waiting, and to everyone after", async () => {
    await fail("s-a");
    await fail("s-b");
    await fleet("s-a").recordFix("E-0001", FIX);
    expect((await fleet("s-b").poll())[0]).toContain(`fix: ${FIX}`);
    expect((await fail("s-c"))[0]).toContain(`fix: ${FIX}`);
  });

  it("hands over a fix recorded while the next agent was claiming the error", async () => {
    await fail("s-a");
    // s-a records its fix and lets the claim go after s-b's hook has read the
    // memory, but before s-b claims the error for itself.
    const files = filesIn(memory);
    const real = nodeStoreFs();
    let recorded = false;
    const racing: StoreFs = {
      ...real,
      async createExclusive(path, data) {
        if (
          !recorded &&
          path === files.lock &&
          (await events()).some((e) => e.kind === "hit")
        ) {
          recorded = true;
          await fleet("s-a").recordFix("E-0001", FIX);
        }
        return real.createExclusive(path, data);
      },
    };
    const notices = await createFleet(
      memory,
      "agent-s-b",
      "s-b",
      {},
      { fs: racing },
    ).failure(capture, call);
    expect(recorded).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`fix: ${FIX}`);
    // It did not take the error on: no claim stays, and none was logged.
    expect(await readFile(files.claims, "utf8")).not.toContain("agent-s-b");
    expect(
      (await events())
        .filter((e) => e.agent === "agent-s-b")
        .map((e) => [e.kind, e.notice]),
    ).toEqual([
      ["hit", undefined],
      ["notice", "hit"],
    ]);
  });

  it("does not log a release when nobody held the claim", async () => {
    await fail("s-a");
    await fleet("s-a").endSession();
    await fleet("s-b").recordFix("E-0001", FIX);
    expect((await events()).at(-1)).toMatchObject({
      kind: "fix",
      agent: "agent-s-b",
    });
  });

  it("returns undefined for an unknown entry, and refuses a blank fix", async () => {
    expect(await fleet("s-a").recordFix("E-0404", FIX)).toBeUndefined();
    await expect(fleet("s-a").recordFix("E-0001", " \n ")).rejects.toThrow(
      RangeError,
    );
    expect(await events()).toEqual([]);
  });
});

describe("fleet: injection off (paused)", () => {
  it("records and holds without telling, then delivers once it resumes", async () => {
    const off = { inject: "off" as const };
    expect(await fail("s-a", off)).toEqual([]);
    // The second agent is not hinted while injection is off, but waits.
    expect(await fail("s-b", off)).toEqual([]);
    const session = JSON.parse(
      await readFile(join(memory, "sessions", "s-b.json"), "utf8"),
    );
    expect(session.holding).toHaveLength(1);
    await recordFix();
    expect(await createFleet(memory, "agent-s-b", "s-b", off).poll()).toEqual(
      [],
    );
    const [notice] = await createFleet(memory, "agent-s-b", "s-b").poll();
    expect(notice).toContain(`fix: ${FIX}`);
  });
});

describe("fleet: the review gate", () => {
  const fleet = (session: string) =>
    createFleet(memory, `agent-${session}`, session);
  // A fix that came from outside and no person has approved yet.
  const held = (mark: string) =>
    createStore(filesIn(memory)).update("E-0001", {
      fix: FIX,
      status: "fixed",
      meta: { review: mark },
    });
  const mark = async () =>
    parseDocument(await readFile(filesIn(memory).errors, "utf8")).blocks[0]
      ?.entry.meta.review;

  it("offers no fix that waits for a person, so the agent diagnoses it", async () => {
    await fail("s-a");
    await fleet("s-a").endSession();
    await held(REVIEW_ALL);
    expect(await fail("s-b")).toEqual([
      "[antibody] E-0001 seen before (2 hits), no fix recorded yet.",
    ]);
    expect((await events()).at(-2)).toMatchObject({
      kind: "claim",
      agent: "agent-s-b",
    });
  });

  it("does not deliver it to an agent that waits", async () => {
    await fail("s-a");
    await fail("s-b");
    await held("fix");
    expect(await fleet("s-b").poll()).toEqual([]);
  });

  it("lets a fix recorded in the fleet release a held fix", async () => {
    await fail("s-a");
    await held("fix");
    const entry = await fleet("s-a").recordFix("E-0001", FIX);
    expect(entry?.meta).not.toHaveProperty("review");
    expect(await mark()).toBeUndefined();
    expect((await fail("s-c"))[0]).toContain(`fix: ${FIX}`);
  });

  it("keeps imported text held when the fix is the fleet's own", async () => {
    await fail("s-a");
    await held(REVIEW_ALL);
    await fleet("s-a").recordFix("E-0001", FIX);
    expect(await mark()).toBe("text");
    expect((await fail("s-c"))[0]).toContain(`fix: ${FIX}`);
  });
});

describe("fleet: the claimant's transcript", () => {
  const transcript = "/tmp/agent-a/session.jsonl";

  it("is recorded on the claim of a new error, and of a known one", async () => {
    await fail("s-a", { transcript });
    expect((await events()).find((e) => e.kind === "claim")).toMatchObject({
      agent: "agent-s-a",
      id: "E-0001",
      transcript,
    });
    await createFleet(memory, "agent-s-a", "s-a").endSession();
    await fail("s-b", { transcript: "/tmp/agent-b/session.jsonl" });
    expect(
      (await events()).filter((e) => e.kind === "claim").at(-1),
    ).toMatchObject({
      agent: "agent-s-b",
      transcript: "/tmp/agent-b/session.jsonl",
    });
  });

  it("measures what the diagnosis cost when the fix is recorded", async () => {
    const file = join(memory, "..", "agent-a.jsonl");
    await fail("s-a", { transcript: file });
    // The claimant worked on it: two model calls after its claim.
    const usage = (id: string, output: number) =>
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: { id, usage: { input_tokens: 100, output_tokens: output } },
      });
    await writeFile(file, `${usage("m1", 300)}\n${usage("m2", 500)}\n`);
    await createFleet(memory, "agent-s-a", "s-a").recordFix("E-0001", FIX);
    expect((await events()).find((e) => e.kind === "fix")).toMatchObject({
      agent: "agent-s-a",
      id: "E-0001",
      tokens: 1_000,
    });
  });

  it("records no cost it could not measure", async () => {
    await fail("s-a", { transcript: join(memory, "..", "missing.jsonl") });
    await createFleet(memory, "agent-s-a", "s-a").recordFix("E-0001", FIX);
    expect((await events()).find((e) => e.kind === "fix")).not.toHaveProperty(
      "tokens",
    );
  });

  it("is left out when the hook named none", async () => {
    await fail("s-a");
    expect((await events()).find((e) => e.kind === "claim")).not.toHaveProperty(
      "transcript",
    );
  });
});
