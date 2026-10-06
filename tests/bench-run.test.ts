// The benchmark's runner: its command line, a run's record when agents fail or
// stall, and a whole benchmark of scripted agents with injection on and off.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeDriver } from "../bench/drivers";
import type { Driver } from "../bench/drivers";
import { main, parseArgs, runBenchmark } from "../bench/run";
import type { BenchOptions } from "../bench/run";
import { BENCH_DIR } from "../bench/tasks";

// Not the project's usual port: other test files hold that one and 4818.
const PORT = 4819;

let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "antibody-bench-out-"));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

const options = (o: BenchOptions | { error: string }): BenchOptions => {
  if ("error" in o) throw new Error(o.error);
  return o;
};

describe("parseArgs", () => {
  it("runs eight scripted agents three times in each arm by default", () => {
    const o = options(parseArgs([], new Date("2026-10-06T09:00:00.000Z")));
    expect(o).toMatchObject({
      agents: 8,
      runs: 3,
      arms: ["on", "off"],
      timeoutMs: 30 * 60_000,
      keep: false,
      out: join(BENCH_DIR, "results", "2026-10-06T09-00-00-000Z"),
    });
    expect(o.driver.describe(8)).toBe(
      "8 scripted agents (fixes recorded when asked)",
    );
  });

  it("takes every option", () => {
    const o = options(
      parseArgs([
        "--agent",
        "fake",
        "--agents",
        "1",
        "--runs",
        "2",
        "--arms",
        "off",
        "--out",
        "elsewhere",
        "--timeout-min",
        "5",
        "--keep",
        "--speed",
        "0.5",
        "--record",
        "fixed",
        "--patience-ms",
        "0",
      ]),
    );
    expect(o).toMatchObject({
      agents: 1,
      runs: 2,
      arms: ["off"],
      out: "elsewhere",
      timeoutMs: 5 * 60_000,
      keep: true,
    });
    expect(o.driver.describe(1)).toBe(
      "1 scripted agent (fixes recorded once they work)",
    );
  });

  it.each([
    [["--agents"], "unknown or incomplete option: --agents"],
    [["agents"], "unknown or incomplete option: agents"],
    [["--colour", "red"], "unknown option: --colour"],
    [["--agents", "0"], "--agents, --runs and --timeout-min"],
    [["--runs", "1.5"], "--agents, --runs and --timeout-min"],
    [["--timeout-min", "soon"], "--agents, --runs and --timeout-min"],
    [["--arms", "on,maybe"], "--arms takes on, off, or on,off"],
    [["--speed", "0"], "--speed takes a number above 0"],
    [["--record", "never"], "--record takes asked or fixed"],
    [["--patience-ms", "-1"], "--patience-ms takes a number"],
    [["--agent", "claude"], "unknown agent: claude"],
  ])("refuses %j", (argv, message) => {
    const o = parseArgs(argv);
    expect("error" in o && o.error).toContain(message);
  });
});

describe("main", () => {
  it("prints the usage on a bad option", async () => {
    const lines: string[] = [];
    expect(await main(["--runs", "none"], (l) => lines.push(l))).toBe(2);
    expect(lines.join("\n")).toContain("usage: pnpm run bench");
  });
});

describe("runBenchmark", () => {
  it("records an agent that failed, one that stalled and one that did nothing", async () => {
    const stub: Driver = {
      describe: (n) => `${n} stubs`,
      run: async ({ worktree }) => {
        if (worktree.endsWith("wt-1")) throw new Error("no such model");
        if (worktree.endsWith("wt-2")) return new Promise(() => {});
        return {};
      },
    };
    const lines: string[] = [];
    const { runs, markdown } = await runBenchmark({
      driver: stub,
      agents: 3,
      runs: 1,
      arms: ["off"],
      out,
      timeoutMs: 200,
      keep: true,
      port: PORT,
      log: (l) => lines.push(l),
    });
    const run = runs[0];
    expect(run.arm).toBe("off");
    expect(run.agents.map((a) => a.error)).toEqual([
      "Error: no such model",
      "timed out after 200 ms",
      undefined,
    ]);
    // Nobody did their task, nobody met a trap, and no tokens were measured.
    expect(run.agents.every((a) => !a.done && a.tokens === undefined)).toBe(
      true,
    );
    expect(run.diagnoses).toBe(0);
    expect(markdown).toContain("Benchmark: 3 stubs. Medians per run.");
    expect(markdown).toContain("| off | 1 | - |");
    expect(markdown).toContain("0 / 3 |");
    expect(markdown).toContain("Tokens leave out 1 run");

    // The workspace was kept, with injection off in its memory.
    const kept = lines
      .find((l) => l.includes("workspace kept: "))
      ?.split("workspace kept: ")[1] as string;
    try {
      expect(existsSync(join(kept, "shop", ".git", "antibody", "paused"))).toBe(
        true,
      );
    } finally {
      rmSync(kept, { recursive: true, force: true });
    }
    expect(existsSync(join(out, "run-1-off", "summary.json"))).toBe(true);
    expect(lines[0]).toBe("run 1 of 1, injection off: 3 stubs");
    expect(lines.at(-1)).toBe(
      "  0 trap diagnoses (0 repeats), 0 of 3 tasks done",
    );
  });

  it("runs scripted agents with injection on and off, and writes the results", async () => {
    const lines: string[] = [];
    const { runs, markdown } = await runBenchmark({
      // Patient enough that a loaded machine cannot outlast it.
      driver: fakeDriver({ speed: 0.02, record: "fixed", patienceMs: 20_000 }),
      agents: 2,
      runs: 1,
      arms: ["on", "off"],
      out,
      timeoutMs: 90_000,
      port: PORT,
      log: (l) => lines.push(l),
    });
    const [on, off] = runs;
    expect(on?.arm).toBe("on");
    expect(off?.arm).toBe("off");
    for (const run of [on, off])
      for (const agent of run?.agents ?? []) {
        expect(agent.done).toBe(true);
        expect(agent.tokens).toBeGreaterThan(0);
      }
    // Off: each agent diagnoses all four traps, and records nothing.
    expect(off?.diagnoses).toBe(8);
    expect(off?.repeatDiagnoses).toBe(4);
    expect(off?.fixNotices).toBe(0);
    for (const agent of off?.agents ?? [])
      expect(agent.details?.recorded).toEqual([]);
    // On: a fix one agent found reached the other.
    expect(on?.fixNotices).toBeGreaterThan(0);
    expect(on?.diagnoses).toBeLessThan(8);

    expect(markdown).toContain(
      "2 scripted agents (fixes recorded once they work)",
    );
    expect(markdown).toContain("With injection on:");
    expect(readFileSync(join(out, "results.md"), "utf8")).toBe(markdown);
    expect(
      JSON.parse(readFileSync(join(out, "results.json"), "utf8")),
    ).toHaveLength(2);
    // Each run keeps its summary and its agents' transcripts.
    for (const run of [on, off]) {
      const dir = join(out, `run-1-${run?.arm}`);
      expect(existsSync(join(dir, "summary.json"))).toBe(true);
      for (const agent of run?.agents ?? [])
        expect(existsSync(join(dir, `${agent.session}.jsonl`))).toBe(true);
    }
    expect(lines).toContain(
      "run 1 of 1, injection on: 2 scripted agents (fixes recorded once they work)",
    );
  }, 120_000);
});
