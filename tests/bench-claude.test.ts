// The Claude Code driver, against a stand-in for claude: the command line each
// arm gets, the plugin's hooks reaching the real bundle, the tokens read from
// the session's transcripts or from claude's own result, and an agent that
// crashes, hangs or cannot be started.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeDriver,
  resultTokens,
  sessionTranscripts,
} from "../bench/claude";
import type { ClaudeDriverOptions } from "../bench/claude";
import { BUNDLE, main, parseArgs, runBenchmark } from "../bench/run";
import type { RunRecord } from "../bench/run";
import { TASKS } from "../bench/tasks";

// Not the project's usual port: other test files hold 4817 to 4819.
const PORT = 4820;

// Records how it was started, runs the hooks it was given as Claude Code would
// on a failing command, and answers the way `claude -p --output-format json`
// does. STUB_MODE picks a transcript, no transcript, a crash or a hang.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const session = flag("--session-id");
const log = path.join(process.env.STUB_LOG, session);
fs.writeFileSync(log + ".json", JSON.stringify({
  args, cwd: process.cwd(), pid: process.pid,
  parent: process.env.CLAUDECODE ?? null,
  configDir: process.env.CLAUDE_CONFIG_DIR,
}));
const mode = process.env.STUB_MODE;
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "crash") {
  process.stderr.write("first\\nsecond\\nAPI key missing\\n");
  process.exit(1);
} else {
  const { hooks } = JSON.parse(flag("--settings"));
  for (const hook of hooks.PostToolUseFailure[0].hooks)
    execFileSync(hook.command, hook.args, {
      input: JSON.stringify({
        hook_event_name: "PostToolUseFailure", session_id: session,
        cwd: process.cwd(), tool_name: "Bash", tool_input: { command: "npm test" },
        error: "Exit code 1\\nError: Environment variable not found: DATABASE_URL.",
      }),
    });
  if (mode === "transcript") {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-stub");
    fs.mkdirSync(path.join(dir, session, "subagents"), { recursive: true });
    const line = (id, input, output) => JSON.stringify({
      type: "assistant", timestamp: new Date().toISOString(), sessionId: session,
      message: { id, role: "assistant", usage: { input_tokens: input, output_tokens: output } },
    }) + "\\n";
    fs.writeFileSync(path.join(dir, session + ".jsonl"), line("m1", 1000, 200) + line("m2", 500, 100));
    fs.writeFileSync(path.join(dir, session, "subagents", "agent-a.jsonl"), line("s1", 300, 50));
    fs.writeFileSync(path.join(dir, session, "subagents", "notes.txt"), "not a transcript");
  }
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.42,
    usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 999, output_tokens: 30 },
  }));
}
`;

let root: string;
let stub: string;
let config: string;
let log: string;
const saved = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antibody-claude-"));
  stub = join(root, "claude.cjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  config = join(root, "config");
  log = join(root, "log");
  mkdirSync(log);
  process.env.STUB_LOG = log;
  // As if the benchmark were started from inside a Claude Code session.
  process.env.CLAUDECODE = "1";
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

const bench = (
  mode: string,
  o: Partial<ClaudeDriverOptions> = {},
  timeoutMs = 60_000,
) => {
  process.env.STUB_MODE = mode;
  return runBenchmark({
    driver: claudeDriver({
      bin: stub,
      maxBudgetUsd: 0.5,
      configDir: config,
      ...o,
    }),
    agents: 1,
    runs: 1,
    arms: ["on", "off"],
    out: join(root, "out"),
    timeoutMs,
    port: PORT,
  });
};

const started = (run: RunRecord | undefined) =>
  JSON.parse(
    readFileSync(join(log, `${run?.agents[0]?.session}.json`), "utf8"),
  ) as {
    args: string[];
    cwd: string;
    pid: number;
    parent: string | null;
    configDir: string;
  };

describe("the Claude Code driver", () => {
  it("starts claude headless with the plugin's hooks, and its MCP server only with injection on", async () => {
    const { runs } = await bench("usage", { model: "sonnet" });
    const [on, off] = runs;
    for (const run of [on, off]) {
      const { args, cwd, parent, configDir } = started(run);
      expect(args.slice(0, 2)).toEqual([
        "-p",
        (TASKS[0] as (typeof TASKS)[number]).prompt,
      ]);
      const after = (name: string) => args[args.indexOf(name) + 1];
      expect(after("--output-format")).toBe("json");
      expect(after("--session-id")).toBe(run?.agents[0]?.session);
      expect(after("--setting-sources")).toBe("project");
      expect(after("--model")).toBe("sonnet");
      expect(after("--max-budget-usd")).toBe("0.5");
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).toContain("--strict-mcp-config");
      // The plugin's hooks, pointing at the bundle under test.
      const { hooks } = JSON.parse(after("--settings") as string);
      expect(Object.keys(hooks)).toEqual([
        "PreToolUse",
        "SessionStart",
        "UserPromptSubmit",
        "PostToolUse",
        "PostToolUseFailure",
        "SessionEnd",
      ]);
      expect(hooks.PostToolUse[0].hooks[0].args).toEqual([
        BUNDLE,
        "hook",
        "claude-code",
      ]);
      expect(cwd.endsWith("wt-1")).toBe(true);
      // Not taken for the session that started the benchmark.
      expect(parent).toBeNull();
      expect(configDir).toBe(config);
      // The hooks reached antibody, which saw the agent meet the env trap.
      expect(run?.diagnoses).toBe(1);
    }
    const mcp = (run: RunRecord | undefined) => {
      const { args } = started(run);
      return args.includes("--mcp-config")
        ? JSON.parse(args[args.indexOf("--mcp-config") + 1] as string)
        : undefined;
    };
    expect(mcp(on).mcpServers.antibody.args).toEqual([
      BUNDLE,
      "mcp",
      "claude-code",
    ]);
    expect(mcp(off)).toBeUndefined();
  }, 60_000);

  it("measures tokens from the session's transcripts, its subagents' included", async () => {
    const { runs } = await bench("transcript");
    const agent = runs[0]?.agents[0];
    expect(agent?.tokens).toBe(1_200 + 600 + 350);
    expect(agent?.details).toEqual({
      exitCode: 0,
      tokensFrom: "transcript",
      transcripts: 2,
      subtype: "success",
      isError: false,
      turns: 3,
      costUsd: 0.42,
    });
    // Copies are kept with the run, next to what claude printed.
    const dir = join(root, "out", "run-1-on");
    for (const file of [".jsonl", ".1.jsonl", ".out.json"])
      expect(existsSync(join(dir, `${agent?.session}${file}`))).toBe(true);
  }, 60_000);

  it("falls back to claude's own count without a transcript", async () => {
    const { runs } = await bench("usage");
    const agent = runs[0]?.agents[0];
    // Input, cache writes and output; not cache reads.
    expect(agent?.tokens).toBe(60);
    expect(agent?.details).toMatchObject({
      tokensFrom: "result",
      transcripts: 0,
    });
  }, 60_000);

  it("records a claude that crashed, with the end of what it said", async () => {
    const { runs } = await bench("crash");
    expect(runs[0]?.agents[0]?.error).toBe(
      "Error: claude exited with 1: first | second | API key missing",
    );
  }, 60_000);

  it("stops a claude that runs past the timeout", async () => {
    const { runs } = await bench("hang", {}, 500);
    expect(runs[0]?.agents[0]?.error).toBe("timed out after 500 ms");
    const { pid } = started(runs[0]);
    const gone = async () => {
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    expect(await gone()).toBe(true);
  }, 60_000);

  it("records a claude that cannot be started", async () => {
    const { runs } = await bench("usage", {
      bin: join(root, "no-such-claude"),
    });
    expect(runs[0]?.agents[0]?.error).toContain("ENOENT");
  }, 60_000);
});

describe("reading what claude spent", () => {
  it("finds no transcripts without a projects folder or a session", () => {
    expect(sessionTranscripts(config, "s-1")).toEqual([]);
    mkdirSync(join(config, "projects", "-elsewhere"), { recursive: true });
    expect(sessionTranscripts(config, "s-1")).toEqual([]);
  });

  it("counts nothing from a result without usage", () => {
    expect(resultTokens(undefined)).toBeUndefined();
    expect(resultTokens({})).toBeUndefined();
    expect(
      resultTokens({ usage: { service_tier: "standard" } }),
    ).toBeUndefined();
  });
});

describe("the command line for Claude Code", () => {
  it("needs a spending cap", () => {
    const o = parseArgs(["--agent", "claude"]);
    expect("error" in o && o.error).toContain("--max-budget-usd");
  });

  it("names the fleet and its cap", () => {
    const o = parseArgs([
      "--agent",
      "claude",
      "--max-budget-usd",
      "2",
      "--model",
      "sonnet",
    ]);
    if ("error" in o) throw new Error(o.error);
    expect(o.driver.describe(8)).toBe("8 Claude Code agents (sonnet)");
    expect(o.driver.capUsd).toBe(2);
    const plain = parseArgs(["--agent", "claude", "--max-budget-usd", "2"]);
    if ("error" in plain) throw new Error(plain.error);
    expect(plain.driver.describe(1)).toBe("1 Claude Code agent");
  });

  it("says what a real run may spend before it starts", async () => {
    process.env.STUB_MODE = "usage";
    process.env.CLAUDE_CONFIG_DIR = config;
    const lines: string[] = [];
    const code = await main(
      [
        "--agent",
        "claude",
        "--claude-bin",
        stub,
        "--max-budget-usd",
        "0.25",
        "--agents",
        "1",
        "--runs",
        "2",
        "--arms",
        "off",
        "--port",
        String(PORT),
        "--out",
        join(root, "out"),
      ],
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(lines[0]).toBe(
      "bench: 2 real agent sessions, each capped at $0.25: up to $0.50 in all",
    );
    expect(lines.some((l) => l.endsWith(", $0.42 spent"))).toBe(true);
    expect(lines.at(-1)).toContain("1 Claude Code agent");
  }, 60_000);
});
