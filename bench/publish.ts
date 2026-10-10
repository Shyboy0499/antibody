// Publishing a run's numbers (#132): the artifacts a reader needs to check the
// table, and nothing that carries this machine with it.
//
// A results directory holds more than the numbers: every agent's transcript, the
// client's own output files, and whatever `--keep` left behind. Those name paths
// on this machine, and the repository's privacy guard rejects such a path on
// sight, so they stay out of what is committed. What is published instead is the
// table, the record, each run's summary, an environment.md saying what produced
// them, and a coverage.md saying which commands the traps came through
// (bench/coverage.ts).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runGit } from "../src/paths";
import type { GitRunner } from "../src/paths";
import { collapseAbsolutePaths } from "../src/signature";
import type { Arm } from "./analyze";
import { ARMS } from "./analyze";
import { renderCoverage } from "./coverage";
import type { CoverageRow, RunCoverage } from "./coverage";

/** What a run's summary says that publishing reads. */
interface RunSummaryFile {
  invalid?: boolean;
  coverage?: RunCoverage;
}

/** The facts the published environment records: how to rerun this, and with what. */
export interface RunEnvironment {
  /** The command line that produced the results, this machine's paths collapsed. */
  command: string;
  /** What ran, as the driver describes it: "8 Claude Code agents". */
  fleet: string;
  /** Agents per run. */
  agents: number;
  /** Runs per arm. */
  runs: number;
  arms: readonly Arm[];
  /** Each agent's cap in dollars, for agents that cost. */
  capUsd?: number;
  /** The antibody commit the hooks' bundle was built from. */
  commit: string;
  /** When the results were published. */
  at: Date;
}

/** What publishing needs. */
export interface PublishOptions {
  /** The results directory the runner wrote. */
  out: string;
  /** Where to publish; created when it does not exist. */
  dir: string;
  environment: RunEnvironment;
}

/**
 * The commit the bundle under test was built from.
 *
 * @param root - the antibody checkout.
 * @param git - runs git; the real one by default.
 * @returns the commit, or "unknown" outside a repository.
 */
export function antibodyCommit(root: string, git: GitRunner = runGit): string {
  try {
    return git(["rev-parse", "HEAD"], root).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** The runs a results directory holds, numbered order, on before off. */
export function runDirs(out: string): string[] {
  if (!existsSync(out)) return [];
  const found = readdirSync(out).filter((name) =>
    /^run-\d+-(on|off)$/.test(name),
  );
  const rank = (arm: string) => (ARMS as readonly string[]).indexOf(arm);
  return found.sort((a, b) => {
    const [n = "0", arm = ""] = a.split("-").slice(1);
    const [m = "0", other = ""] = b.split("-").slice(1);
    return Number(n) - Number(m) || rank(arm) - rank(other);
  });
}

/** What each run's summary says, or nothing when it does not parse. */
function summaryOf(dir: string): RunSummaryFile {
  try {
    return JSON.parse(
      readFileSync(join(dir, "summary.json"), "utf8"),
    ) as RunSummaryFile;
  } catch {
    return {};
  }
}

/** What produced the run, as Markdown, with the machine's paths collapsed. */
function renderEnvironment(
  o: RunEnvironment,
  out: string,
  runs: readonly string[],
): string {
  const summaries = runs.map((run) => summaryOf(join(out, run)));
  const leftOut = summaries.filter((s) => s.invalid === true).length;
  const schedule = `${o.agents} agents per run, ${o.runs} runs per arm, arms ${o.arms.join(",")}`;
  const lines = [
    "# The run's environment",
    "",
    `- Command: \`${collapseAbsolutePaths(o.command)}\``,
    `- Fleet: ${o.fleet}`,
    `- Schedule: ${schedule}`,
  ];
  if (o.capUsd !== undefined)
    lines.push(
      `- Each agent capped at $${o.capUsd}: up to $${(o.capUsd * o.agents * o.runs * o.arms.length).toFixed(2)} in all`,
    );
  lines.push(
    `- antibody: ${o.commit}`,
    `- node: ${process.version} on ${process.platform}`,
    `- Runs: ${runs.length - leftOut} scored${leftOut === 0 ? "" : `, ${leftOut} left out`}`,
    `- Published: ${o.at.toISOString()}`,
    "",
  );
  return lines.join("\n");
}

/**
 * Publish a results directory: the table, the record, each run's summary, the
 * environment and the coverage. Every transcript, output file and workspace stays
 * where it is.
 *
 * @param o - the results directory, where to publish, and the environment.
 * @returns the paths written, relative to the published directory.
 */
export function publishRun(o: PublishOptions): string[] {
  const written: string[] = [];
  mkdirSync(o.dir, { recursive: true });
  const copy = (from: string, to: string, relative: string) => {
    copyFileSync(from, to);
    written.push(relative);
  };
  for (const name of ["results.md", "results.json"]) {
    const file = join(o.out, name);
    if (existsSync(file)) copy(file, join(o.dir, name), name);
  }
  const runs = runDirs(o.out);
  const rows: CoverageRow[] = [];
  for (const run of runs) {
    const from = join(o.out, run, "summary.json");
    if (!existsSync(from)) continue;
    const relative = join(run, "summary.json");
    const to = join(o.dir, relative);
    mkdirSync(join(o.dir, run), { recursive: true });
    copy(from, to, relative);
    const summary = summaryOf(join(o.out, run));
    rows.push({
      run,
      ...(summary.coverage === undefined ? {} : { coverage: summary.coverage }),
    });
  }
  const environment = "environment.md";
  writeFileSync(
    join(o.dir, environment),
    renderEnvironment(o.environment, o.out, runs),
  );
  written.push(environment);
  const coverage = "coverage.md";
  writeFileSync(join(o.dir, coverage), renderCoverage(rows));
  written.push(coverage);
  return written;
}
