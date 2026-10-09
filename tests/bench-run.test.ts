// The benchmark's runner: its command line, a run's record when agents fail or
// stall, and a whole benchmark of scripted agents with injection on and off.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeDriver } from "../bench/drivers";
import type { Driver } from "../bench/drivers";
import { main, parseArgs, runBenchmark, stoppedMessage } from "../bench/run";
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
      port: 4817,
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
        "--port",
        "5000",
      ]),
    );
    expect(o).toMatchObject({
      agents: 1,
      runs: 2,
      arms: ["off"],
      out: "elsewhere",
      timeoutMs: 5 * 60_000,
      keep: true,
      port: 5000,
    });
    expect(o.driver.describe(1)).toBe(
      "1 scripted agent (fixes recorded once they work)",
    );
  });

  it("takes a results directory to carry on from, and a flag to keep going", () => {
    const o = options(parseArgs(["--resume", "earlier", "--keep-going"]));
    expect(o).toMatchObject({
      out: "earlier",
      resume: "earlier",
      keepGoing: true,
    });
    // Without them, a usage limit stops the schedule.
    const plain = options(parseArgs([]));
    expect(plain.resume).toBeUndefined();
    expect(plain.keepGoing).toBe(false);
  });

  it.each([
    [["--agents"], "unknown or incomplete option: --agents"],
    [["agents"], "unknown or incomplete option: agents"],
    [["--colour", "red"], "unknown option: --colour"],
    [["--resume", "earlier", "--out", "elsewhere"], "--resume already says"],
    [["--agents", "0"], "--agents, --runs, --timeout-min and --port"],
    [["--runs", "1.5"], "--agents, --runs, --timeout-min and --port"],
    [["--timeout-min", "soon"], "--agents, --runs, --timeout-min and --port"],
    [["--port", "-1"], "--agents, --runs, --timeout-min and --port"],
    [["--arms", "on,maybe"], "--arms takes on, off, or on,off"],
    [["--speed", "0"], "--speed takes a number above 0"],
    [["--record", "never"], "--record takes asked or fixed"],
    [["--patience-ms", "-1"], "--patience-ms takes a number"],
    [["--agent", "aider"], "unknown agent: aider"],
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
    // Two of the three sessions failed, so the run is not scored: it is counted
    // and named under the table instead (#133).
    expect(run.invalid).toBe(true);
    expect(run.invalidReason).toBe("agents were stopped before they finished");
    expect(markdown).toContain("Benchmark: 3 stubs. Medians per run.");
    expect(markdown).toContain("| off | 0 | - |");
    expect(markdown).toContain(
      "1 run left out: agents were stopped before they finished.",
    );

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
      "  run left out: agents were stopped before they finished (2 of 3 agents failed)",
    );
  });

  it("stops at the first run a usage limit stopped, and says how to finish", async () => {
    const stub: Driver = {
      describe: (n) => `${n} stubs`,
      run: async () => {
        throw new Error("claude stopped before it worked: blocking_limit");
      },
    };
    const lines: string[] = [];
    const { runs, stopped, markdown } = await runBenchmark({
      driver: stub,
      agents: 1,
      runs: 3,
      arms: ["on", "off"],
      out,
      timeoutMs: 5_000,
      port: PORT,
      log: (l) => lines.push(l),
    });
    // One run happened, and the other five were not paid for.
    expect(runs).toHaveLength(1);
    expect(stopped).toEqual({
      reason: "sessions hit a usage limit",
      done: 1,
      total: 6,
    });
    expect(lines).toContain(
      "  stopping: sessions hit a usage limit (1 of 6 runs done)",
    );
    // The arm that never ran is not in the table at all.
    expect(markdown).toContain("| on | 0 | - |");
    expect(markdown).not.toContain("| off |");
    expect(markdown).toContain("1 run left out: sessions hit a usage limit.");
    expect(stoppedMessage(stopped!, out)).toBe(
      [
        "Stopped early: sessions hit a usage limit; 1 of 6 runs done.",
        `Rerun the same command with --resume ${out} once it clears: the runs already done are kept.`,
      ].join("\n"),
    );
  }, 60_000);

  it("keeps going when it is told to", async () => {
    let calls = 0;
    const stub: Driver = {
      describe: (n) => `${n} stubs`,
      run: async () => {
        calls++;
        throw new Error("claude stopped before it worked: blocking_limit");
      },
    };
    const { runs, stopped } = await runBenchmark({
      driver: stub,
      agents: 1,
      runs: 2,
      arms: ["on", "off"],
      out,
      timeoutMs: 5_000,
      port: PORT,
      keepGoing: true,
    });
    expect(calls).toBe(4);
    expect(runs).toHaveLength(4);
    expect(stopped).toBeUndefined();
  }, 60_000);

  it("carries on from a directory without running what is already done", async () => {
    let calls = 0;
    const stub: Driver = {
      describe: (n) => `${n} stubs`,
      run: async () => {
        calls++;
        return {};
      },
    };
    const first = await runBenchmark({
      driver: stub,
      agents: 1,
      runs: 1,
      arms: ["off"],
      out,
      timeoutMs: 5_000,
      port: PORT,
    });
    expect(first.runs).toHaveLength(1);
    expect(calls).toBe(1);

    const lines: string[] = [];
    const again = await runBenchmark({
      driver: stub,
      agents: 1,
      runs: 2,
      arms: ["off"],
      out,
      resume: out,
      timeoutMs: 5_000,
      port: PORT,
      log: (l) => lines.push(l),
    });
    // The run already done is kept, and only the second one is paid for.
    expect(calls).toBe(2);
    expect(again.runs).toHaveLength(2);
    expect(lines).toContain("run 1 of 2, injection off: already done");
    // The table and the record cover both, not just the new one.
    expect(again.markdown).toContain("| off | 2 |");
    expect(
      JSON.parse(readFileSync(join(out, "results.json"), "utf8")),
    ).toHaveLength(2);
  }, 60_000);

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
