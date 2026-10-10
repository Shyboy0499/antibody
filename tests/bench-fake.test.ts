// The scripted agent drives the real hooks and MCP server through the
// committed bundle: in a fleet with injection off it diagnoses every trap
// itself; with injection on, and its fixes recorded once they work, a peer's
// fix reaches it; and it stops waiting for a peer that leaves without one.
// Piped, it does the same through `npm test 2>&1 | tail -60`, the shape #131 is
// about, and hands the hook the payload the client would have sent for it.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellCommands } from "../bench/coverage";
import {
  BENCH_SHELL_ENV,
  testRunPayload,
  runFakeAgent,
} from "../bench/fake-agent";
import type { FakeAgentOptions } from "../bench/fake-agent";
import { TASKS } from "../bench/tasks";
import { createWorkspace, holdPort } from "../bench/workspace";
import type { Workspace } from "../bench/workspace";
import { parseHookInput } from "../src/claude-code";
import { toCapture } from "../src/hook-input";
import type { HookInput } from "../src/hook-input";
import { tokensBetween } from "../src/transcript";

const BUNDLE = resolve("dist", "antibody.mjs");
// Not the project's usual port: other test files hold that one.
const PORT = 4818;

// A piped run needs the shell the client's Bash tool would use. `bash` is it,
// except on a machine whose `bash` on PATH cannot run the project (Windows and
// a WSL without a distribution); ANTIBODY_BENCH_SHELL names the right one.
const SHELL = process.env[BENCH_SHELL_ENV] ?? "bash";
const shellWorks = (() => {
  try {
    execFileSync(SHELL, ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// What a piped failing `node --test` leaves in the window the agent reads: the
// verdict, without the trap's own words when the window is narrow.
const PIPED_FAILURE = [
  "Error: Environment variable not found: DATABASE_URL.",
  "",
  "Node.js v24.16.0",
  "✖ test\\validate.test.js (72.3ms)",
  "ℹ tests 7",
  "ℹ fail 7",
  "ℹ duration_ms 224.9546",
].join("\n");

let root: string;
let workspace: Workspace;
let blocker: Server;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-fake-")));
  workspace = createWorkspace(root, 2, PORT);
  blocker = await holdPort(PORT);
});

afterEach(() => {
  blocker.close();
  rmSync(root, { recursive: true, force: true });
});

const fleet = (
  extra: Partial<FakeAgentOptions> = {},
  worktrees: string[] = workspace.worktrees,
) =>
  Promise.all(
    worktrees.map((worktree, i) =>
      runFakeAgent({
        worktree,
        task: TASKS[i] as (typeof TASKS)[number],
        session: `s-${i + 1}`,
        transcript: join(root, `transcript-${i + 1}.jsonl`),
        bundle: BUNDLE,
        speed: 0.02,
        ...extra,
      }),
    ),
  );

describe("the payload of a test run", () => {
  const hookInput = (payload: Record<string, unknown>) =>
    parseHookInput(
      JSON.stringify({ session_id: "s", cwd: "/repo", ...payload }),
    );

  it("hands a piped failure to the hook as the success the client saw", () => {
    // The shell reported the tail's status, so the client calls the run a
    // success and its result carries the output and no exit code (#131). The
    // shared rule is the only thing that can read the failure.
    const payload = testRunPayload(
      "set -o pipefail; npm test 2>&1 | tail -60",
      0,
      PIPED_FAILURE,
    );
    expect(payload.hook_event_name).toBe("PostToolUse");
    const input = hookInput(payload);
    expect(input?.exitCode).toBeUndefined();
    expect(input?.inferredFailure).toBe(true);
    expect(toCapture(input as HookInput)).toMatchObject({
      kind: "command",
      text: expect.stringContaining(
        "Error: Environment variable not found: DATABASE_URL.",
      ),
    });
  });

  it("hands a rewritten failure to the hook as one the client reported", () => {
    const payload = testRunPayload(
      "set -o pipefail; npm test 2>&1 | tail -60",
      1,
      PIPED_FAILURE,
    );
    expect(payload.hook_event_name).toBe("PostToolUseFailure");
    // The prefix the rewrite added is not part of the command the entry keeps,
    // so a piped and an unpiped run of one command stay one signature.
    expect(toCapture(hookInput(payload) as HookInput)).toMatchObject({
      kind: "command",
      command: "npm test 2>&1 | tail -60",
      text: expect.stringContaining("[exit code: 1]"),
    });
  });

  it("writes a failure that printed nothing as `Exit code N` alone", () => {
    expect(testRunPayload("npm test", 3, "  \n").error).toBe("Exit code 3");
    expect(testRunPayload("npm test", 1, "boom").error).toBe(
      "Exit code 1\nboom",
    );
  });
});

describe("the scripted agent", () => {
  it("diagnoses every trap itself when injection is off, and does its task", async () => {
    mkdirSync(workspace.memory, { recursive: true });
    writeFileSync(join(workspace.memory, "paused"), "off\n");
    const reports = await fleet();
    for (const report of reports) {
      expect(report.passed).toBe(true);
      expect(report.diagnosed).toEqual([
        "lockfile",
        "env",
        "generated",
        "port",
      ]);
      expect(report.helped).toEqual([]);
    }
    // Its pretend model calls are measured like a real agent's.
    const tokens = tokensBetween(
      readFileSync(join(root, "transcript-1.jsonl"), "utf8"),
      new Date(0),
      new Date(),
    );
    expect(tokens).toBe(6_000 + 1_800 + 2_400 + 2_600 + 3_000);
  }, 60_000);

  it.skipIf(!shellWorks)(
    "piped, gets past every trap and records the call as one with a pipe in it",
    async () => {
      mkdirSync(workspace.memory, { recursive: true });
      writeFileSync(join(workspace.memory, "paused"), "off\n");
      const reports = await fleet({ pipe: true });
      for (const report of reports) {
        expect(report.passed).toBe(true);
        expect(report.diagnosed).toEqual([
          "lockfile",
          "env",
          "generated",
          "port",
        ]);
      }
      // The transcript holds the Bash call, pipe and all, which is what the
      // coverage report reads to tell a piped run from one that is not (#131).
      const commands = shellCommands(
        readFileSync(join(root, "transcript-1.jsonl"), "utf8"),
      );
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((command) => command.piped)).toBe(true);
    },
    120_000,
  );

  it("is given a peer's fix when injection is on and fixes are recorded once they work", async () => {
    // Patient enough that a loaded machine cannot outlast it.
    const reports = await fleet({ record: "fixed", patienceMs: 20_000 });
    for (const report of reports) expect(report.passed).toBe(true);
    expect(reports.flatMap((r) => r.helped).length).toBeGreaterThan(0);
    expect(reports.flatMap((r) => r.recorded).length).toBeGreaterThan(0);
  }, 60_000);

  it("is asked for each fix as it gets past its trap, and records it", async () => {
    // Alone, and recording only when asked: each failure on the next trap
    // asks for the fix of the one before.
    const [report] = await fleet({}, [workspace.worktrees[0] as string]);
    expect(report?.passed).toBe(true);
    expect(report?.diagnosed).toHaveLength(4);
    expect(report?.recorded.slice(0, 3)).toEqual([
      "E-0001",
      "E-0002",
      "E-0003",
    ]);
  }, 60_000);

  it("stops waiting for a peer that leaves without a fix, and diagnoses it", async () => {
    const [mine, theirs] = workspace.worktrees as [string, string];
    const peer = (payload: Record<string, unknown>) =>
      execFileSync(process.execPath, [BUNDLE, "hook", "claude-code"], {
        cwd: theirs,
        input: JSON.stringify({ session_id: "peer", cwd: theirs, ...payload }),
      });
    // A peer meets the lockfile trap first, and claims it.
    const test = spawnSync("npm", ["test"], { cwd: theirs, encoding: "utf8" });
    peer({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: `Exit code 1\n${test.stdout}${test.stderr}`,
    });
    // Then it leaves without recording a fix, which lets its claim go.
    const leaves = setTimeout(
      () => peer({ hook_event_name: "SessionEnd", reason: "exit" }),
      1_500,
    );
    const started = Date.now();
    try {
      const [report] = await fleet({ patienceMs: 60_000 }, [mine]);
      expect(report?.passed).toBe(true);
      expect(report?.diagnosed).toContain("lockfile");
      // Told no fix was recorded, it did not wait out its patience.
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      clearTimeout(leaves);
    }
  }, 90_000);
});
