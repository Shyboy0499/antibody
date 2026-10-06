// A scripted agent, so the benchmark's runner can be checked without a model.
//
// It behaves the way the benchmark needs a real agent to, through antibody's
// real interfaces: it does its task, runs `npm test`, and hands every result
// to the committed bundle exactly as Claude Code would (`antibody hook
// claude-code` on stdin). When a test run fails on one of the traps it acts on
// what the hook said: a fix notice is applied at once; a claim hint makes it
// wait, re-running the tests, for as long as its patience lasts or until it is
// told no fix was recorded; otherwise it diagnoses the trap itself, which costs
// it tokens and time. Its fixes are
// recorded through `antibody mcp claude-code`, like a real agent's
// antibody_record call: when the hook asks for one, which is antibody's own
// protocol, or, with `record: "fixed"`, as soon as a fix is seen to work.
//
// Every model call it pretends to make is written to a Claude Code transcript,
// so tokens are measured the same way as a real agent's (src/transcript.ts).
// Its knowledge of each trap's fix (bench/traps.ts) stands in for reasoning;
// the costs stand in for what reasoning takes. Its numbers check the runner
// and show the protocol at work - they are not a result about real agents.
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryDir, filesIn } from "../src/paths";
import { parseDocument } from "../src/store";
import { solutionDir } from "./tasks";
import type { Task } from "./tasks";
import { TRAPS, trapOf } from "./traps";
import type { Trap } from "./traps";

type TrapId = Trap["id"];

/** What each thing it pretends to think about costs, in tokens. */
export interface FakeCosts {
  task: number;
  diagnose: Record<TrapId, number>;
  /** Reading a fix notice and applying it. */
  applyKnown: number;
  /** Waiting for a peer's fix, per test run. */
  poll: number;
}

export const DEFAULT_FAKE_COSTS: FakeCosts = {
  task: 6_000,
  diagnose: { lockfile: 1_800, env: 2_400, generated: 2_600, port: 3_000 },
  applyKnown: 250,
  poll: 120,
};

/** How long each takes at speed 1, in milliseconds. */
export const FAKE_TIMINGS = {
  task: 3_000,
  diagnose: 4_000,
  poll: 1_500,
  patience: 30_000,
};

export interface FakeAgentOptions {
  worktree: string;
  task: Task;
  session: string;
  /** Where its transcript is written. */
  transcript: string;
  /** The antibody bundle to call. */
  bundle: string;
  costs?: FakeCosts;
  /** Multiplies every duration: 0.01 for tests. */
  speed?: number;
  /** When it records a fix: when asked (antibody's protocol), or once it works. */
  record?: "asked" | "fixed";
  /** How long it waits for a peer's fix, in milliseconds; by speed otherwise. */
  patienceMs?: number;
  /** The most test runs before it gives up. */
  maxRuns?: number;
}

/** What it did. */
export interface FakeAgentReport {
  runs: number;
  passed: boolean;
  diagnosed: TrapId[];
  /** Traps it fixed from a notice. */
  helped: TrapId[];
  /** Entries whose fix it recorded. */
  recorded: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a command; resolves with its exit code and output, never rejects. */
function run(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", () => resolve({ code: 1, out, err }));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    child.stdin.end(options.input ?? "");
  });
}

/**
 * Run one scripted agent to the end of its task.
 *
 * @param o - its worktree, task, session, transcript and the bundle.
 */
export async function runFakeAgent(
  o: FakeAgentOptions,
): Promise<FakeAgentReport> {
  const costs = o.costs ?? DEFAULT_FAKE_COSTS;
  const speed = o.speed ?? 1;
  const wait = (ms: number) => sleep(ms * speed);
  const report: FakeAgentReport = {
    runs: 0,
    passed: false,
    diagnosed: [],
    helped: [],
    recorded: [],
  };
  let call = 0;
  // One pretend model call, written as Claude Code writes it.
  const think = (tokens: number) => {
    const output = Math.round(tokens * 0.3);
    appendFileSync(
      o.transcript,
      `${JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId: o.session,
        message: {
          id: `msg_${o.session}_${call++}`,
          role: "assistant",
          usage: { input_tokens: tokens - output, output_tokens: output },
        },
      })}\n`,
    );
  };

  const hook = async (fields: Record<string, unknown>): Promise<string> => {
    const payload = {
      session_id: o.session,
      transcript_path: o.transcript,
      cwd: o.worktree,
      ...fields,
    };
    const { out } = await run(
      process.execPath,
      [o.bundle, "hook", "claude-code"],
      { cwd: o.worktree, input: JSON.stringify(payload) },
    );
    try {
      return String(
        JSON.parse(out).hookSpecificOutput?.additionalContext ?? "",
      );
    } catch {
      return "";
    }
  };

  // The entry the memory holds for a trap, to name in antibody_record.
  const entryOf = (trap: TrapId): string | undefined => {
    try {
      const text = readFileSync(filesIn(memoryDir(o.worktree)).errors, "utf8");
      return parseDocument(text).blocks.find(
        (b) => trapOf(`${b.entry.title}\n${b.entry.raw}`)?.id === trap,
      )?.entry.id;
    } catch {
      return undefined;
    }
  };
  const trapOfEntry = (id: string): TrapId | undefined =>
    TRAPS.find((t) => entryOf(t.id) === id)?.id;

  const recordFix = async (id: string, trap: TrapId) => {
    const fix = (TRAPS.find((t) => t.id === trap) as Trap).fix;
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fake-agent", version: "0" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "antibody_record", arguments: { id, fix } },
      },
    ];
    think(costs.applyKnown);
    await run(process.execPath, [o.bundle, "mcp", "claude-code"], {
      cwd: o.worktree,
      input: messages.map((m) => JSON.stringify(m)).join("\n"),
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: o.worktree,
        CLAUDE_CODE_SESSION_ID: o.session,
      },
    });
    report.recorded.push(id);
  };

  // The traps it diagnosed itself, and those whose fix it has not recorded.
  const mine = new Set<TrapId>();
  const unrecorded = new Set<TrapId>();

  // Asked for a fix it found: record it. A request can come with any hook
  // call, a failing one included.
  const answer = async (context: string) => {
    for (const [, id] of context.matchAll(/(E-\d+) looks resolved/g)) {
      const asked = trapOfEntry(id as string);
      if (asked !== undefined && mine.has(asked) && unrecorded.has(asked)) {
        unrecorded.delete(asked);
        await recordFix(id as string, asked);
      }
    }
  };

  await hook({ hook_event_name: "SessionStart", source: "startup" });
  await hook({ hook_event_name: "UserPromptSubmit", prompt: o.task.prompt });

  // The task itself.
  think(costs.task);
  await wait(FAKE_TIMINGS.task);
  for (const file of o.task.solution)
    cpSync(join(solutionDir(o.task), file), join(o.worktree, file));

  let held: { trap: TrapId; since: number } | undefined;
  for (let n = 0; n < (o.maxRuns ?? 40); n++) {
    report.runs++;
    const test = await run("npm", ["test"], {
      cwd: o.worktree,
      env: { ...process.env, npm_config_loglevel: "silent" },
    });
    const output = `${test.out}${test.err}`;
    const trap = trapOf(output);

    // A fix it found has worked once its error is gone.
    if (o.record === "fixed")
      for (const done of unrecorded)
        if (trap?.id !== done) {
          unrecorded.delete(done);
          const id = entryOf(done);
          if (id !== undefined) await recordFix(id, done);
        }

    if (test.code === 0) {
      const context = await hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { stdout: output, stderr: "", exit_code: 0 },
      });
      await answer(context);
      report.passed = true;
      break;
    }

    const context = await hook({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: `Exit code ${test.code}\n${output}`,
    });
    await answer(context);
    if (trap === undefined) break;

    if (context.includes("| fix: ")) {
      think(costs.applyKnown);
      trap.apply(o.worktree);
      report.helped.push(trap.id);
      held = undefined;
      continue;
    }
    if (context.includes("has been diagnosing this"))
      held ??= { trap: trap.id, since: Date.now() };
    // Nobody is on it any more and no fix was recorded: take it on.
    if (context.includes("no fix recorded yet")) held = undefined;
    if (
      held?.trap === trap.id &&
      Date.now() - held.since < (o.patienceMs ?? FAKE_TIMINGS.patience * speed)
    ) {
      think(costs.poll);
      await wait(FAKE_TIMINGS.poll);
      continue;
    }

    // Nobody it can learn from: work it out.
    think(costs.diagnose[trap.id]);
    await wait(FAKE_TIMINGS.diagnose);
    trap.apply(o.worktree);
    report.diagnosed.push(trap.id);
    mine.add(trap.id);
    unrecorded.add(trap.id);
    held = undefined;
  }

  await hook({ hook_event_name: "SessionEnd", reason: "exit" });
  return report;
}
