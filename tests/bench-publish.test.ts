// Publishing a run (#132): what its transcripts can prove about the commands its
// traps came through, and the artifacts a reader gets - and does not get - from
// `--publish`.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coverageOf, renderCoverage, shellCommands } from "../bench/coverage";
import type { RunCoverage } from "../bench/coverage";
import { antibodyCommit, publishRun, runDirs } from "../bench/publish";
import { main, parseArgs } from "../bench/run";
import type { MemoryEvent } from "../src/events";
import type { Entry } from "../src/store";

// Not the ports other test files hold: 4817, 4818, 4819 and 4820.
const PORT = 4821;

let root: string;
let out: string;
let published: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antibody-bench-publish-"));
  out = join(root, "results");
  published = join(root, "published");
  mkdirSync(out, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const entry = (id: string, title: string): Entry => ({
  id,
  title,
  meta: { sig: id },
  fingerprint: id,
  category: "command-exit / Bash",
  firstSeen: "2026-10-10",
  lastSeen: "2026-10-10",
  hits: 1,
  trigger: "npm test",
  raw: title,
  fix: "",
  status: "open",
  notes: "",
});

const LOCKFILE = entry(
  "E-0001",
  'npm test → ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"',
);
const PORT_ENTRY = entry(
  "E-0002",
  "Error: listen EADDRINUSE: address already in use :::4817",
);

/** A transcript line as Claude Code writes one: a tool call with its time. */
const call = (o: { at: string; tool?: string; command?: string }): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: o.at,
    message: {
      content: [
        {
          type: "tool_use",
          name: o.tool ?? "Bash",
          input: { command: o.command },
        },
      ],
    },
  });

const at = (n: number) =>
  new Date(Date.UTC(2026, 9, 10, 10, 0, n)).toISOString();

const event = (
  session: string,
  id = "E-0001",
  kind: MemoryEvent["kind"] = "hit",
  when = at(2),
): MemoryEvent => ({
  v: 1,
  t: when,
  kind,
  agent: `claude-code@${session}`,
  session,
  id,
});

describe("shellCommands", () => {
  it("reads a session's Bash calls, and which of them hold a pipe", () => {
    const text = [
      "not json at all",
      call({ at: at(1), command: "npm test" }),
      call({ at: at(2), tool: "Read", command: "src/cart.js" }),
      call({ at: at(3), command: "npm test 2>&1 | tail -15" }),
      // `||` is not a pipeline, and neither is a lone pipe character.
      call({ at: at(4), command: "npm test || true" }),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}',
      '{"type":"assistant","message":"no content"}',
      "",
    ].join("\n");
    expect(shellCommands(text)).toEqual([
      { at: Date.parse(at(1)), piped: false },
      { at: Date.parse(at(3)), piped: true },
      { at: Date.parse(at(4)), piped: false },
    ]);
  });

  it("keeps a call with no timestamp as a call", () => {
    const text = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls | cat" } },
        ],
      },
    });
    expect(shellCommands(text)).toEqual([{ at: Number.NaN, piped: true }]);
  });
});

describe("coverageOf", () => {
  it("counts a trap as piped when the session had run a pipe first", () => {
    const coverage = coverageOf({
      transcripts: [
        {
          session: "s-1",
          text: [
            call({ at: at(1), command: "npm test 2>&1 | tail -15" }),
            call({ at: at(9), command: "cat .env.example" }),
          ].join("\n"),
        },
        { session: "s-2", text: call({ at: at(1), command: "npm test" }) },
      ],
      events: [event("s-1"), event("s-2")],
      entries: [LOCKFILE, PORT_ENTRY],
    });
    expect(coverage).toEqual({
      sessions: 2,
      bash: 2,
      piped: 1,
      traps: [
        { trap: "lockfile", met: 2, piped: 1 },
        { trap: "env", met: 0, piped: 0 },
        { trap: "generated", met: 0, piped: 0 },
        { trap: "port", met: 0, piped: 0 },
      ],
    });
  });

  it("does not count a pipe the session ran after it met the trap", () => {
    const coverage = coverageOf({
      transcripts: [
        {
          session: "s-1",
          text: [
            call({ at: at(5), command: "npm test | tail -3" }),
            call({ at: at(6), command: "npm test || true" }),
          ].join("\n"),
        },
      ],
      events: [event("s-1", "E-0001", "hit", at(2))],
      entries: [LOCKFILE],
    });
    expect(coverage.traps[0]).toEqual({ trap: "lockfile", met: 1, piped: 0 });
    // The second command is not a pipeline: the session still ran only one pipe.
    expect(coverage.piped).toBe(1);
    expect(coverage.bash).toBe(1);
  });

  it("counts a meeting with no time to order by, and a session with no transcript", () => {
    const coverage = coverageOf({
      transcripts: [
        { session: "s-1", text: call({ at: at(5), command: "a | b" }) },
      ],
      events: [
        event("s-1", "E-0001", "hit", "not a time"),
        event("s-2", "E-0001"),
      ],
      entries: [LOCKFILE],
    });
    expect(coverage.sessions).toBe(1);
    expect(coverage.traps[0]).toEqual({ trap: "lockfile", met: 2, piped: 1 });
  });

  it("says nothing about sessions that ran no Bash command", () => {
    const coverage = coverageOf({
      transcripts: [
        {
          session: "s-1",
          text: '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
        },
      ],
      events: [],
      entries: [],
    });
    expect(coverage).toEqual({
      sessions: 1,
      bash: 0,
      piped: 0,
      traps: [
        { trap: "lockfile", met: 0, piped: 0 },
        { trap: "env", met: 0, piped: 0 },
        { trap: "generated", met: 0, piped: 0 },
        { trap: "port", met: 0, piped: 0 },
      ],
    });
  });
});

describe("renderCoverage", () => {
  const coverage: RunCoverage = {
    sessions: 2,
    bash: 2,
    piped: 1,
    traps: [
      { trap: "lockfile", met: 2, piped: 1 },
      { trap: "env", met: 1, piped: 1 },
      { trap: "generated", met: 0, piped: 0 },
      { trap: "port", met: 0, piped: 0 },
    ],
  };

  it("prints one row per run, with what each trap came through", () => {
    const report = renderCoverage([
      { run: "run-1-on", coverage },
      { run: "run-1-off" },
    ]);
    expect(report).toContain(
      "| Run | Sessions | Ran Bash | Ran a pipe | lockfile | env | generated | port |",
    );
    expect(report).toContain(
      "| run-1-on | 2 | 2 | 1 | 2 (1 piped) | 1 (1 piped) | - | - |",
    );
    expect(report).toContain("| run-1-off | - | - | - | - | - | - | - |");
    expect(report).toContain("run-1-off recorded no coverage");
  });

  it("says when a run's transcripts hold no command at all", () => {
    const report = renderCoverage([
      {
        run: "run-2-on",
        coverage: { ...coverage, sessions: 8, bash: 0, piped: 0 },
      },
    ]);
    expect(report).toContain("1 of 1 runs hold no Bash command");
  });
});

describe("runDirs", () => {
  it("lists the runs in numbered order, on before off", () => {
    for (const name of ["run-10-off", "run-2-on", "run-1-off", "run-2-off"]) {
      mkdirSync(join(out, name), { recursive: true });
    }
    writeFileSync(join(out, "results.md"), "# not a run\n");
    expect(runDirs(out)).toEqual([
      "run-1-off",
      "run-2-on",
      "run-2-off",
      "run-10-off",
    ]);
    expect(runDirs(join(root, "nowhere"))).toEqual([]);
  });
});

describe("antibodyCommit", () => {
  it("reads the commit, and says unknown when git cannot", () => {
    expect(antibodyCommit("/repo", () => "  deadbee\n")).toBe("deadbee");
    expect(antibodyCommit("/repo", () => "")).toBe("unknown");
    expect(
      antibodyCommit("/repo", () => {
        throw new Error("not a repository");
      }),
    ).toBe("unknown");
  });
});

describe("publishRun", () => {
  it("publishes the numbers, and never a transcript or this machine's paths", () => {
    const coverage: RunCoverage = {
      sessions: 8,
      bash: 8,
      piped: 5,
      traps: [
        { trap: "lockfile", met: 8, piped: 5 },
        { trap: "env", met: 7, piped: 4 },
        { trap: "generated", met: 7, piped: 4 },
        { trap: "port", met: 6, piped: 3 },
      ],
    };
    writeFileSync(join(out, "results.md"), "# the table\n");
    writeFileSync(join(out, "results.json"), "[]\n");
    mkdirSync(join(out, "run-1-on"), { recursive: true });
    writeFileSync(
      join(out, "run-1-on", "summary.json"),
      `${JSON.stringify({ arm: "on", invalid: false, coverage }, null, 2)}\n`,
    );
    // What a results directory holds besides the numbers: a transcript and the
    // client's own output, both naming this machine.
    writeFileSync(
      join(out, "run-1-on", "session.jsonl"),
      `${JSON.stringify({ cwd: "C:\\Users\\someone\\bench\\wt-1" })}\n`,
    );
    writeFileSync(join(out, "run-1-on", "session.out.json"), "{}\n");
    writeFileSync(join(out, "notes.txt"), "scratch\n");

    const written = publishRun({
      out,
      dir: published,
      environment: {
        command:
          "pnpm run bench -- --agent claude --agents 8 --runs 3 --max-budget-usd 1 --resume C:\\Users\\someone\\bench\\results",
        fleet: "8 Claude Code agents",
        agents: 8,
        runs: 3,
        arms: ["on", "off"],
        capUsd: 1,
        commit: "deadbee",
        at: new Date("2026-10-10T12:00:00.000Z"),
      },
    });

    expect([...written].sort()).toEqual(
      [
        "results.md",
        "results.json",
        join("run-1-on", "summary.json"),
        "environment.md",
        "coverage.md",
      ].sort(),
    );
    // Only the summary of a run is published, never its transcripts.
    expect(existsSync(join(published, "run-1-on", "session.jsonl"))).toBe(
      false,
    );
    expect(existsSync(join(published, "run-1-on", "session.out.json"))).toBe(
      false,
    );
    expect(existsSync(join(published, "notes.txt"))).toBe(false);

    // Every file the published directory actually holds, read back to check that
    // none of them names this machine.
    const files = (readdirSync(published, { recursive: true }) as string[])
      .map((name) => join(published, name))
      .filter((file) => statSync(file).isFile());
    expect(files).toHaveLength(5);
    for (const file of files)
      expect(readFileSync(file, "utf8")).not.toMatch(/[A-Za-z]:\\/);

    const environment = readFileSync(join(published, "environment.md"), "utf8");
    expect(environment).toContain(
      "Command: `pnpm run bench -- --agent claude --agents 8 --runs 3 --max-budget-usd 1 --resume <path>\\results`",
    );
    expect(environment).toContain("- Fleet: 8 Claude Code agents");
    expect(environment).toContain(
      "- Schedule: 8 agents per run, 3 runs per arm, arms on,off",
    );
    expect(environment).toContain(
      "- Each agent capped at $1: up to $48.00 in all",
    );
    expect(environment).toContain("- antibody: deadbee");
    expect(environment).toContain(`- node: ${process.version} on `);
    expect(environment).toContain("- Runs: 1 scored");
    expect(environment).toContain("- Published: 2026-10-10T12:00:00.000Z");

    const coverageReport = readFileSync(join(published, "coverage.md"), "utf8");
    expect(coverageReport).toContain(
      "| run-1-on | 8 | 8 | 5 | 8 (5 piped) | 7 (4 piped) | 7 (4 piped) | 6 (3 piped) |",
    );
  });

  it("publishes what a stopped schedule wrote, and counts what it left out", () => {
    writeFileSync(join(out, "results.md"), "# the table\n");
    for (const [name, invalid] of [
      ["run-1-on", false],
      ["run-1-off", true],
    ] as const) {
      mkdirSync(join(out, name), { recursive: true });
      writeFileSync(
        join(out, name, "summary.json"),
        `${JSON.stringify({ arm: name.endsWith("on") ? "on" : "off", invalid })}\n`,
      );
    }
    publishRun({
      out,
      dir: published,
      environment: {
        command: "pnpm run bench --",
        fleet: "1 scripted agent",
        agents: 1,
        runs: 1,
        arms: ["on", "off"],
        commit: "unknown",
        at: new Date("2026-10-10T12:00:00.000Z"),
      },
    });
    const environment = readFileSync(join(published, "environment.md"), "utf8");
    expect(environment).toContain("- Runs: 1 scored, 1 left out");
    // No cap is named for agents that do not cost.
    expect(environment).not.toContain("capped at");
    // Its coverage was not recorded, so the report says so rather than zeroes.
    expect(readFileSync(join(published, "coverage.md"), "utf8")).toContain(
      "run-1-on, run-1-off recorded no coverage",
    );
  });
});

describe("parseArgs", () => {
  it("takes a directory to publish into", () => {
    expect(
      parseArgs(["--publish", "bench/published/2026-10-10"]),
    ).toMatchObject({
      publish: "bench/published/2026-10-10",
    });
    expect(parseArgs([])).not.toHaveProperty("publish");
  });
});

describe("main", () => {
  it("publishes a scripted run, and says what its coverage is", async () => {
    const lines: string[] = [];
    const code = await main(
      [
        "--agents",
        "1",
        "--runs",
        "1",
        "--arms",
        "off",
        "--speed",
        "0.02",
        "--record",
        "fixed",
        "--port",
        String(PORT),
        "--out",
        out,
        "--publish",
        published,
      ],
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(lines).toContain(`Published 5 files to ${published}`);
    expect(existsSync(join(published, "results.md"))).toBe(true);
    expect(existsSync(join(published, "environment.md"))).toBe(true);
    // The scripted agent writes no tool call, so the run cannot say what its
    // traps came through - and the report says that instead of claiming zero.
    expect(readFileSync(join(published, "coverage.md"), "utf8")).toContain(
      "hold no Bash command in their transcripts",
    );
    const summary = JSON.parse(
      readFileSync(join(out, "run-1-off", "summary.json"), "utf8"),
    ) as { coverage?: RunCoverage };
    expect(summary.coverage?.sessions).toBe(1);
    expect(summary.coverage?.bash).toBe(0);
  }, 120_000);
});
