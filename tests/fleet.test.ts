import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureInput } from "../src/capture";
import { readEventsFrom } from "../src/events";
import { createFleet } from "../src/fleet";
import type { FleetOptions } from "../src/fleet";
import { filesIn } from "../src/paths";
import type { ToolCall } from "../src/resolve-detect";
import { parseState } from "../src/state";
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
    ]);
  });

  it("announces a miss when inject is always", async () => {
    expect(await fail("s-a", { inject: "always" })).toEqual([
      "[antibody] recorded as E-0001 (no fix yet).",
    ]);
  });

  it("counts a repeat in state.json and says no fix is recorded yet", async () => {
    await fail("s-a");
    const notices = await fail("s-b");
    expect(notices).toEqual([
      "[antibody] E-0001 seen before (2 hits), no fix recorded yet.",
    ]);
    const state = parseState(await readFile(filesIn(memory).state, "utf8"));
    expect(state?.entries["E-0001"]?.hits).toBe(1);
    expect((await events()).map((e) => e.kind)).toEqual([
      "miss",
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
    const tokens = (await events()).find((e) => e.kind === "notice")?.tokens;
    expect(tokens).toBeGreaterThan(0);
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
    expect((await events()).map((e) => e.kind)).toEqual(["miss", "hit"]);
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
