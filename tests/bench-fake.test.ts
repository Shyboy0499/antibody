// The scripted agent drives the real hooks and MCP server through the
// committed bundle: in a fleet with injection off it diagnoses every trap
// itself; with injection on, and its fixes recorded once they work, a peer's
// fix reaches it.
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
import { runFakeAgent } from "../bench/fake-agent";
import type { FakeAgentOptions } from "../bench/fake-agent";
import { TASKS } from "../bench/tasks";
import { createWorkspace, holdPort } from "../bench/workspace";
import type { Workspace } from "../bench/workspace";
import { tokensBetween } from "../src/transcript";

const BUNDLE = resolve("dist", "antibody.mjs");
// Not the project's usual port: other test files hold that one.
const PORT = 4818;

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

const fleet = (extra: Partial<FakeAgentOptions> = {}) =>
  Promise.all(
    workspace.worktrees.map((worktree, i) =>
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

  it("is given a peer's fix when injection is on and fixes are recorded once they work", async () => {
    // Patient enough that a loaded machine cannot outlast it.
    const reports = await fleet({ record: "fixed", patienceMs: 20_000 });
    for (const report of reports) expect(report.passed).toBe(true);
    expect(reports.flatMap((r) => r.helped).length).toBeGreaterThan(0);
    expect(reports.flatMap((r) => r.recorded).length).toBeGreaterThan(0);
  }, 60_000);
});
