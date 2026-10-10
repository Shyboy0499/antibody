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
//
// With `pipe: true` it runs the tests the way real Claude Code agents do, in a
// shell: `npm test 2>&1 | tail -60` (#131). A pipeline reports its last
// command's status, so the client calls a failing run a success and its result
// carries no exit code at all. The agent asks the plugin's PreToolUse hook what
// to run before each call, as the client does, and hands the hook the payload
// the client would send for the status the shell reported: a failure when the
// hook's rewrite made the shell report one, and a success whose result is only
// the output otherwise. What the hook makes of that is what the run measures.
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { looksFailed } from "../src/failure-hints";
import { memoryDir, filesIn } from "../src/paths";
import { parseDocument } from "../src/store";
import { solutionDir } from "./tasks";
import type { Task } from "./tasks";
import { TRAPS, trapOf } from "./traps";
import type { Trap } from "./traps";

type TrapId = Trap["id"];

/**
 * The piped test command: the shape real Claude Code agents use (#131), and the
 * one the `pipe` option below runs.
 *
 * Sixty lines, not the fifteen the issue's evidence quotes, because `node
 * --test` prints each failing file's crash block before its summary: with
 * `tail -15` two of the four traps' own words are cut away, and while such a run
 * is still recorded (the runner's verdict is in the window) neither the agent
 * nor the memory entry can name the trap it met. Sixty is the narrowest window
 * that names all four.
 */
export const PIPED_TEST_COMMAND = "npm test 2>&1 | tail -60";

/**
 * The shell a piped run uses, when the environment does not name one: `bash`,
 * which is what Claude Code's Bash tool runs. `ANTIBODY_BENCH_SHELL` names
 * another one, for a machine whose `bash` is not the one that can run the
 * project (Windows, where `bash` on `PATH` may be a WSL without a distribution),
 * and `sh` is the fallback when the named shell cannot be started at all.
 */
export const BENCH_SHELL_ENV = "ANTIBODY_BENCH_SHELL";

/** The harness name of the plugin's PreToolUse hook (src/pipefail.ts). */
const PRE_TOOL = "claude-code-pretool";

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
  /**
   * Run the tests through a pipe, as real agents do (#131), and hand the hook
   * the payload the client would send for the status the shell reported.
   */
  pipe?: boolean;
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

/** What one command left behind. */
interface CommandResult {
  code: number;
  out: string;
  err: string;
  /** Set when the command itself could not be started. */
  missing?: boolean;
}

/** Run a command; resolves with its exit code and output, never rejects. */
function run(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", () => resolve({ code: 1, out, err, missing: true }));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    child.stdin.end(options.input ?? "");
  });
}

/**
 * Run a command line in a shell, which is how the client's Bash tool runs one.
 *
 * The shell is `ANTIBODY_BENCH_SHELL` when the environment names one, `bash`
 * otherwise, and `sh` when the named shell cannot be started at all - a
 * pipeline needs a POSIX shell, and `sh` is the one every machine has.
 *
 * @param command - the command line, a pipeline included.
 * @param options - the working directory and environment.
 */
function shellRun(
  command: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const shell = options.env?.[BENCH_SHELL_ENV] ?? "bash";
  return run(shell, ["-c", command], options).then((result) =>
    result.missing === true && shell !== "sh"
      ? run("sh", ["-c", command], options)
      : result,
  );
}

/**
 * The hook call a client makes for one Bash run, as Claude Code 2.1.282 words
 * it: a success arrives on `PostToolUse` with the result object, which carries
 * no exit code at all, and a failure arrives on `PostToolUseFailure` with `Exit
 * code N` leading the error (#131).
 *
 * @param command - the command the client ran, prefix and all, as its
 *   `tool_input` carries it.
 * @param code - the status the shell reported for that command.
 * @param output - everything the command printed.
 */
export function testRunPayload(
  command: string,
  code: number,
  output: string,
): Record<string, unknown> {
  const base = { tool_name: "Bash", tool_input: { command } };
  if (code !== 0)
    return {
      ...base,
      hook_event_name: "PostToolUseFailure",
      // A one-line wording carries no output of its own; a failure that printed
      // something carries it after the wording.
      error:
        output.trim() === ""
          ? `Exit code ${code}`
          : `Exit code ${code}\n${output}`,
    };
  return {
    ...base,
    hook_event_name: "PostToolUse",
    tool_response: {
      stdout: output,
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    },
  };
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

  // Every Bash call is in the transcript, as the client writes it, so the
  // coverage report (bench/coverage.ts) can say which commands the traps came
  // through - and, with `pipe`, that the command had a pipe in it.
  const toolCall = (command: string) => {
    appendFileSync(
      o.transcript,
      `${JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId: o.session,
        message: {
          id: `msg_${o.session}_${call++}`,
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command } }],
        },
      })}\n`,
    );
  };

  // The plugin's PreToolUse hook, asked before a Bash call, as the client asks
  // it: its answer may carry the command the shell will really run, with the
  // pipefail prefix (src/pipefail.ts). A payload it cannot read, or no answer
  // at all, leaves the command as the agent wrote it.
  const preTool = async (command: string): Promise<string> => {
    const { out } = await run(process.execPath, [o.bundle, "hook", PRE_TOOL], {
      cwd: o.worktree,
      input: JSON.stringify({
        session_id: o.session,
        transcript_path: o.transcript,
        cwd: o.worktree,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
    });
    try {
      const rewritten = (
        JSON.parse(out) as {
          hookSpecificOutput?: { updatedInput?: { command?: unknown } };
        }
      ).hookSpecificOutput?.updatedInput?.command;
      return typeof rewritten === "string" && rewritten.trim() !== ""
        ? rewritten
        : command;
    } catch {
      return command;
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
    // What the agent asked for, and what the client runs: with `pipe`, the tests
    // go through a shell as a pipeline, and the plugin's PreToolUse hook may
    // have put `set -o pipefail` in front of it.
    const command =
      o.pipe === true ? await preTool(PIPED_TEST_COMMAND) : "npm test";
    toolCall(command);
    const test =
      o.pipe === true
        ? await shellRun(command, {
            cwd: o.worktree,
            env: { ...process.env, npm_config_loglevel: "silent" },
          })
        : await run("npm", ["test"], {
            cwd: o.worktree,
            env: { ...process.env, npm_config_loglevel: "silent" },
          });
    const output = `${test.out}${test.err}`;
    const trap = trapOf(output);
    // A pipeline reports its last command's status, so an un-rewritten
    // `npm test | tail` that failed exits 0: the client calls the call a
    // success, and only the output says otherwise. The agent reads the output
    // either way, which is what a real one does.
    const failed =
      test.code !== 0 || (o.pipe === true && looksFailed(command, output));

    // A fix it found has worked once its error is gone.
    if (o.record === "fixed")
      for (const done of unrecorded)
        if (trap?.id !== done) {
          unrecorded.delete(done);
          const id = entryOf(done);
          if (id !== undefined) await recordFix(id, done);
        }

    if (!failed) {
      // The status the shell reported, and no other: a 0 goes as the client's
      // success, whose result is the output and nothing else.
      const context = await hook(testRunPayload(command, test.code, output));
      await answer(context);
      report.passed = true;
      break;
    }

    const context = await hook(testRunPayload(command, test.code, output));
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
