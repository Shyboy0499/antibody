// The benchmark's runner (roadmap M5): the same fleet, on the same tasks, with
// antibody's injection on and with it off, several times each.
//
// A run builds a fresh workspace - the project committed, a worktree per agent
// - holds the project's default port as another agent's server would, starts
// every agent at once, each on its own task, and waits for them all. Then it
// checks each agent's work with the task's hidden acceptance check, and reads
// antibody's memory for who met which trap and who diagnosed it
// (bench/analyze.ts). In the off arm the hooks still record, silently, so both
// arms are measured the same way. Runs alternate which arm goes first, so
// nothing that drifts over a session favours one.
//
// A run also says what its traps came through (bench/coverage.ts), and the
// results can be published (`--publish`): the artifacts a reader needs, and none
// of the files that name this machine (bench/publish.ts).
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEvents } from "../src/events";
import { filesIn, PAUSE_FILE_NAME } from "../src/paths";
import { parseDocument } from "../src/store";
import {
  ARMS,
  USAGE_LIMIT_REASON,
  leftOutRuns,
  renderResults,
  summariseArms,
  summariseRun,
} from "./analyze";
import type { AgentResult, Arm, RunSummary } from "./analyze";
import { claudeDriver } from "./claude";
import { coverageOf } from "./coverage";
import type { RunCoverage, SessionTranscript } from "./coverage";
import { fakeDriver } from "./drivers";
import type { Driver, DriverResult } from "./drivers";
import { antibodyCommit, publishRun } from "./publish";
import { BENCH_DIR, TASKS, checkFile } from "./tasks";
import type { Task } from "./tasks";
import { BENCH_PORT } from "./traps";
import { createWorkspace, holdPort } from "./workspace";

/** The antibody bundle the agents' hooks call. */
export const BUNDLE = resolve(BENCH_DIR, "..", "dist", "antibody.mjs");

/** What a benchmark runs. */
export interface BenchOptions {
  driver: Driver;
  agents: number;
  runs: number;
  arms: readonly Arm[];
  /** Where the results are written. */
  out: string;
  timeoutMs: number;
  /** Keep each run's workspace, to look at afterwards. */
  keep?: boolean;
  /** The project's default port, which each run holds. */
  port?: number;
  /**
   * A directory of earlier runs to carry on from: the runs finished there are
   * kept as they are, and only the rest are run (and paid for).
   */
  resume?: string;
  /** Keep going after a session was stopped by a usage limit. Stopping is the
   * default, because a limit that has started will not clear by itself. */
  keepGoing?: boolean;
  /**
   * Where to publish the results once they are written: the table, the record,
   * each run's summary, the environment and the coverage - and none of the
   * files that name this machine (bench/publish.ts).
   */
  publish?: string;
  log?: (line: string) => void;
}

/** What stopped a schedule early, for the caller to say how to carry on. */
export interface Stopped {
  /** How the left-out run reads, such as "sessions hit a usage limit". */
  reason: string;
  /** Runs done, the earlier ones included, and how many were asked for. */
  done: number;
  total: number;
}

/**
 * The runs a directory already holds, by arm and run number, so a schedule can
 * carry on from it: a `summary.json` that does not parse, or a run a usage limit
 * made invalid, is not a finished run and is run again.
 *
 * @param dir - the results directory of an earlier run.
 */
export function earlierRuns(dir: string): Map<string, RunRecord> {
  const found = new Map<string, RunRecord>();
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const match = /^run-(\d+)-(on|off)$/.exec(entry);
    if (match === null) continue;
    const file = join(dir, entry, "summary.json");
    if (!existsSync(file)) continue;
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
      // A run a limit made invalid did not finish: it is run again.
      if (record.invalid !== true) found.set(`${match[2]}:${match[1]}`, record);
    } catch {
      // Run it again.
    }
  }
  return found;
}

/**
 * What to say when a schedule stopped early: what happened, and the command
 * that finishes the rest without paying for the runs already done.
 *
 * @param stopped - what stopped the schedule.
 * @param out - the directory the results are in.
 */
export function stoppedMessage(stopped: Stopped, out: string): string {
  return [
    `Stopped early: ${stopped.reason}; ${stopped.done} of ${stopped.total} runs done.`,
    `Rerun the same command with --resume ${out} once it clears: the runs already done are kept.`,
  ].join("\n");
}

/** One agent's result as the run's record keeps it. */
export interface AgentRecord extends AgentResult {
  session: string;
  details?: Record<string, unknown>;
}

/** One run's summary, with each agent's full record. */
export type RunRecord = Omit<RunSummary, "agents"> & {
  agents: AgentRecord[];
  /** What the run's transcripts say about the commands its traps came through. */
  coverage?: RunCoverage;
};

/**
 * The transcripts a run left in its own directory. A subagent's transcript is
 * `<session>.<n>.jsonl`, so the session is the name before the first dot, which
 * keeps it with the session that started it.
 *
 * @param runDir - the run's directory.
 */
export function runTranscripts(runDir: string): SessionTranscript[] {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => ({
      session: name.slice(0, name.indexOf(".")),
      text: readFileSync(join(runDir, name), "utf8"),
    }));
}

/**
 * Check a task the way the benchmark scores it: the hidden check, in the
 * agent's worktree. The traps are not what it measures, so its environment
 * keeps them out of the way.
 */
export function checkTask(worktree: string, task: Task): boolean {
  if (!existsSync(join(worktree, "generated", "client.js")))
    execFileSync(process.execPath, ["scripts/generate.js"], {
      cwd: worktree,
      stdio: "ignore",
    });
  const run = spawnSync(process.execPath, ["--test", checkFile(task)], {
    cwd: worktree,
    env: { ...process.env, DATABASE_URL: "file:./check.db", PORT: "0" },
    stdio: "ignore",
  });
  return run.status === 0;
}

/** Run an agent, giving up when it takes too long. */
async function withTimeout(
  work: Promise<DriverResult>,
  ms: number,
): Promise<DriverResult & { error?: string }> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<DriverResult & { error: string }>((done) => {
    timer = setTimeout(() => done({ error: `timed out after ${ms} ms` }), ms);
  });
  try {
    return await Promise.race([
      work.catch((error: unknown) => ({ error: String(error) })),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One run of one arm.
 *
 * @param arm - injection on or off.
 * @param n - the run's number, from 1.
 * @param o - the benchmark's options.
 */
export async function runOnce(
  arm: Arm,
  n: number,
  o: BenchOptions,
): Promise<RunRecord> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `antibody-bench-${arm}-`)),
  );
  const runDir = join(o.out, `run-${n}-${arm}`);
  mkdirSync(runDir, { recursive: true });
  const workspace = createWorkspace(root, o.agents, o.port ?? BENCH_PORT);
  // Off: the hooks record what happens and tell the agents nothing.
  if (arm === "off") {
    mkdirSync(workspace.memory, { recursive: true });
    writeFileSync(
      join(workspace.memory, PAUSE_FILE_NAME),
      "benchmark: injection off\n",
    );
  }
  const blocker = await holdPort(workspace.port);
  let agents: AgentRecord[];
  try {
    agents = await Promise.all(
      workspace.worktrees.map(async (worktree, i) => {
        const task = TASKS[i % TASKS.length] as Task;
        const session = randomUUID();
        const started = Date.now();
        const result = await withTimeout(
          o.driver.run({
            worktree,
            task,
            session,
            arm,
            runDir,
            bundle: BUNDLE,
            timeoutMs: o.timeoutMs,
          }),
          o.timeoutMs,
        );
        return {
          agent: `claude-code@wt-${i + 1}`,
          task: task.id,
          session,
          ...(result.tokens === undefined ? {} : { tokens: result.tokens }),
          durationMs: Date.now() - started,
          done: false,
          ...(result.details === undefined ? {} : { details: result.details }),
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      }),
    );
  } finally {
    blocker.close();
  }
  for (const [i, agent] of agents.entries())
    agent.done = checkTask(
      workspace.worktrees[i] as string,
      TASKS[i % TASKS.length] as Task,
    );

  const files = filesIn(workspace.memory);
  const events = existsSync(files.events)
    ? parseEvents(readFileSync(files.events, "utf8")).events
    : [];
  const entries = existsSync(files.errors)
    ? parseDocument(readFileSync(files.errors, "utf8")).blocks.map(
        (b) => b.entry,
      )
    : [];
  const summary = {
    ...summariseRun(arm, agents, events, entries),
    agents,
    coverage: coverageOf({
      transcripts: runTranscripts(runDir),
      events,
      entries,
    }),
  };
  writeFileSync(
    join(runDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  if (o.keep === true) o.log?.(`  workspace kept: ${root}`);
  else rmSync(root, { recursive: true, force: true });
  return summary;
}

/**
 * The whole benchmark: every run of every arm, then the table. A results
 * directory can be carried on from (`resume`), and a schedule stops at the
 * first run a usage limit stopped it in, unless it is told to keep going.
 *
 * @returns each run's summary, the results as Markdown, and what stopped the
 *   schedule early when something did.
 */
export async function runBenchmark(
  o: BenchOptions,
): Promise<{ runs: RunRecord[]; markdown: string; stopped?: Stopped }> {
  mkdirSync(o.out, { recursive: true });
  const earlier =
    o.resume === undefined
      ? new Map<string, RunRecord>()
      : earlierRuns(o.resume);
  const total = o.runs * o.arms.length;
  const runs: RunRecord[] = [];
  let stopped: Stopped | undefined;
  for (let n = 1; n <= o.runs && stopped === undefined; n++) {
    // Alternate which arm goes first.
    const order = n % 2 === 1 ? o.arms : [...o.arms].reverse();
    for (const arm of order) {
      const already = earlier.get(`${arm}:${n}`);
      if (already !== undefined) {
        runs.push(already);
        o.log?.(`run ${n} of ${o.runs}, injection ${arm}: already done`);
        continue;
      }
      o.log?.(
        `run ${n} of ${o.runs}, injection ${arm}: ${o.driver.describe(o.agents)}`,
      );
      const run = await runOnce(arm, n, o);
      runs.push(run);
      const spent = run.agents.reduce(
        (sum, a) =>
          sum +
          (typeof a.details?.costUsd === "number" ? a.details.costUsd : 0),
        0,
      );
      o.log?.(
        `  ${run.diagnoses} trap diagnoses (${run.repeatDiagnoses} repeats), ${run.agents.filter((a) => a.done).length} of ${run.agents.length} tasks done${spent > 0 ? `, $${spent.toFixed(2)} spent` : ""}`,
      );
      if (run.invalid)
        o.log?.(
          `  run left out: ${run.invalidReason} (${run.agents.filter((a) => a.error !== undefined).length} of ${run.agents.length} agents failed)`,
        );
      // A usage limit that has started will not clear by itself, so the rest of
      // the schedule would be paid for and thrown away.
      if (
        run.invalid &&
        run.invalidReason === USAGE_LIMIT_REASON &&
        o.keepGoing !== true
      ) {
        stopped = {
          reason: run.invalidReason,
          done: runs.filter((r) => r.invalid !== true).length,
          total,
        };
        o.log?.(
          `  stopping: ${stopped.reason} (${stopped.done} of ${total} runs done)`,
        );
        break;
      }
    }
  }
  const markdown = renderResults(
    summariseArms(runs),
    o.driver.describe(o.agents),
    leftOutRuns(runs),
  );
  writeFileSync(join(o.out, "results.md"), markdown);
  writeFileSync(
    join(o.out, "results.json"),
    `${JSON.stringify(runs, null, 2)}\n`,
  );
  return { runs, markdown, ...(stopped === undefined ? {} : { stopped }) };
}

const USAGE = `usage: pnpm run bench -- [options]
  --agent fake          the kind of agent (default fake)
  --agents N            agents per run, one task each (default 8)
  --runs N              runs per arm (default 3)
  --arms on,off         which arms to run (default both)
  --out DIR             where results go (default bench/results/<time>)
  --resume DIR          carry on from a results directory: the runs finished
                        there are kept, and only the rest are run
  --keep-going          keep going after a usage limit stopped a session;
                        by default the schedule stops there
  --publish DIR         also publish the results there: the table, the record,
                        each run's summary, the environment and the coverage,
                        and none of the files that name this machine
  --timeout-min N       give up on an agent after N minutes (default 30)
  --keep                keep each run's workspace
  --port N              the project's port, which each run keeps busy (default ${BENCH_PORT})
 the scripted agent:
  --speed X             multiply its pretend durations (default 1)
  --record asked|fixed  record fixes when asked, or once they work (default asked)
  --patience-ms N       how long it waits for a peer's fix
  --pipe                run the tests through a pipe, as real agents do
                        (\`npm test 2>&1 | tail -60\`), so the shell reports the
                        tail's status and the hook has only the output (#131)
 Claude Code (--agent claude), which costs money:
  --max-budget-usd X    each agent's spending cap in dollars (required)
  --model NAME          the model, by claude's own name for it
  --claude-bin PATH     the claude command (default claude)
`;

/** The runner's options from its command line, or a usage error. */
export function parseArgs(
  argv: readonly string[],
  now: Date = new Date(),
): BenchOptions | { error: string } {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--keep" || arg === "--keep-going" || arg === "--pipe")
      switches.add(arg);
    else if (arg.startsWith("--") && argv[i + 1] !== undefined)
      flags.set(arg, argv[++i] as string);
    else return { error: `unknown or incomplete option: ${arg}` };
  }
  const known = [
    "--agent",
    "--agents",
    "--runs",
    "--arms",
    "--out",
    "--resume",
    "--publish",
    "--timeout-min",
    "--speed",
    "--record",
    "--patience-ms",
    "--max-budget-usd",
    "--model",
    "--claude-bin",
    "--port",
  ];
  for (const flag of flags.keys())
    if (!known.includes(flag)) return { error: `unknown option: ${flag}` };

  const resume = flags.get("--resume");
  if (resume !== undefined && flags.has("--out"))
    return {
      error: "--resume already says where the results go, so drop --out",
    };
  const publish = flags.get("--publish");

  const count = (flag: string, fallback: number) => {
    const value = flags.get(flag);
    if (value === undefined) return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : Number.NaN;
  };
  const agents = count("--agents", 8);
  const runs = count("--runs", 3);
  const timeout = count("--timeout-min", 30);
  const port = count("--port", BENCH_PORT);
  if ([agents, runs, timeout, port].some(Number.isNaN))
    return {
      error:
        "--agents, --runs, --timeout-min and --port take a whole number above 0",
    };
  const arms = (flags.get("--arms") ?? ARMS.join(",")).split(",");
  if (
    arms.length === 0 ||
    !arms.every((a) => (ARMS as readonly string[]).includes(a))
  )
    return { error: "--arms takes on, off, or on,off" };

  const agent = flags.get("--agent") ?? "fake";
  let driver: Driver;
  if (agent === "fake") {
    const speed = Number(flags.get("--speed") ?? 1);
    const record = flags.get("--record") ?? "asked";
    const patience = flags.get("--patience-ms");
    if (!(speed > 0)) return { error: "--speed takes a number above 0" };
    if (record !== "asked" && record !== "fixed")
      return { error: "--record takes asked or fixed" };
    if (patience !== undefined && !(Number(patience) >= 0))
      return { error: "--patience-ms takes a number of milliseconds" };
    driver = fakeDriver({
      speed,
      record,
      ...(patience === undefined ? {} : { patienceMs: Number(patience) }),
      ...(switches.has("--pipe") ? { pipe: true } : {}),
    });
  } else if (agent === "claude") {
    const cap = Number(flags.get("--max-budget-usd"));
    if (!(cap > 0))
      return {
        error:
          "--agent claude needs --max-budget-usd, each agent's cap in dollars",
      };
    if (switches.has("--pipe"))
      return { error: "--pipe is for the scripted agent (--agent fake)" };
    const model = flags.get("--model");
    driver = claudeDriver({
      bin: flags.get("--claude-bin") ?? "claude",
      maxBudgetUsd: cap,
      ...(model === undefined ? {} : { model }),
    });
  } else return { error: `unknown agent: ${agent}` };

  return {
    driver,
    agents,
    runs,
    arms: arms as Arm[],
    out:
      resume ??
      flags.get("--out") ??
      join(BENCH_DIR, "results", now.toISOString().replace(/[:.]/g, "-")),
    timeoutMs: timeout * 60_000,
    keep: switches.has("--keep"),
    port,
    ...(resume === undefined ? {} : { resume }),
    keepGoing: switches.has("--keep-going"),
    ...(publish === undefined ? {} : { publish }),
  };
}

/**
 * The runner's command line.
 *
 * @returns the exit code: 0, 1 when the bundle is missing, 2 on usage.
 */
export async function main(
  argv: readonly string[],
  log: (line: string) => void = console.log,
): Promise<number> {
  const options = parseArgs(argv);
  if ("error" in options) {
    log(`bench: ${options.error}\n${USAGE}`);
    return 2;
  }
  if (!existsSync(BUNDLE)) {
    log(`bench: no bundle at ${BUNDLE}; run pnpm run build first`);
    return 1;
  }
  if (options.driver.capUsd !== undefined) {
    const sessions = options.agents * options.runs * options.arms.length;
    log(
      `bench: ${sessions} real agent sessions, each capped at $${options.driver.capUsd}: up to $${(sessions * options.driver.capUsd).toFixed(2)} in all`,
    );
  }
  const { markdown, stopped } = await runBenchmark({ ...options, log });
  log(`\n${markdown}\nResults in ${options.out}`);
  if (options.publish !== undefined) {
    const published = publishRun({
      out: options.out,
      dir: options.publish,
      environment: {
        // The command as a reader would rerun it, with this machine's paths
        // (a `--resume`, an `--out`, a `--claude-bin`) collapsed.
        command: `pnpm run bench -- ${argv.join(" ")}`,
        fleet: options.driver.describe(options.agents),
        agents: options.agents,
        runs: options.runs,
        arms: options.arms,
        ...(options.driver.capUsd === undefined
          ? {}
          : { capUsd: options.driver.capUsd }),
        commit: antibodyCommit(resolve(BENCH_DIR, "..")),
        at: new Date(),
      },
    });
    log(`Published ${published.length} files to ${options.publish}`);
  }
  // A schedule that stopped early says what is left and how to finish it.
  if (stopped !== undefined) log(`\n${stoppedMessage(stopped, options.out)}`);
  return 0;
}
