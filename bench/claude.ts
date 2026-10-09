// Real agents for the benchmark: Claude Code, headless (`claude -p`), one per
// worktree, with antibody installed the way its plugin installs it.
//
// Both arms get the plugin's own hooks (hooks/hooks.json), so the memory sees
// every failure either way; with injection off it is paused and they stay
// silent. Only the on arm gets the plugin's MCP server (.claude-plugin), whose
// tools an agent uses to record a fix. Nothing else of the user's own setup
// comes in: only the project's settings are read, and only these MCP servers.
//
// A real run costs money: every agent is a full Claude Code session, and each
// has its own spending cap.
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { tokensBetween } from "../src/transcript";
import type { AgentContext, Driver } from "./drivers";
import { BENCH_DIR } from "./tasks";

/** The antibody checkout the plugin's files are read from. */
const PLUGIN_ROOT = resolve(BENCH_DIR, "..");
const PLUGIN_BUNDLE = "${CLAUDE_PLUGIN_ROOT}/dist/antibody.mjs";

export interface ClaudeDriverOptions {
  /** The claude command. */
  bin: string;
  /** Each agent's spending cap, in dollars. */
  maxBudgetUsd: number;
  model?: string;
  /** Where Claude Code keeps its sessions: CLAUDE_CONFIG_DIR, or ~/.claude. */
  configDir?: string;
}

/** What `claude -p --output-format json` prints when it is done. */
interface ClaudeResult {
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  /** Why the turn ended, from the client's own list; `completed` ran to the end. */
  terminal_reason?: string;
  /** The turn's closing text, when it wrote one. */
  result?: string;
  stop_reason?: string | null;
}

// Environment a parent Claude Code session would pass on, and which would
// make the agent, or antibody's MCP server, take that session for its own.
const PARENT_SESSION = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
];

/** A file of the plugin, with its root replaced by the bundle's path. */
function pluginFile(file: string, bundle: string): Record<string, unknown> {
  const fill = (value: unknown): unknown =>
    typeof value === "string"
      ? value.replaceAll(PLUGIN_BUNDLE, bundle)
      : Array.isArray(value)
        ? value.map(fill)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, fill(v)]),
            )
          : value;
  return fill(
    JSON.parse(readFileSync(join(PLUGIN_ROOT, file), "utf8")),
  ) as Record<string, unknown>;
}

/** The command line for one agent. */
export function claudeArgs(
  context: AgentContext,
  o: ClaudeDriverOptions,
): string[] {
  const { hooks } = pluginFile(join("hooks", "hooks.json"), context.bundle);
  const { mcpServers } = pluginFile(
    join(".claude-plugin", "plugin.json"),
    context.bundle,
  );
  return [
    "-p",
    context.task.prompt,
    "--output-format",
    "json",
    "--session-id",
    context.session,
    "--dangerously-skip-permissions",
    "--setting-sources",
    "project",
    "--settings",
    JSON.stringify({ hooks }),
    // --mcp-config takes several values, so a flag must follow it.
    ...(context.arm === "on"
      ? ["--mcp-config", JSON.stringify({ mcpServers })]
      : []),
    "--strict-mcp-config",
    ...(o.model === undefined ? [] : ["--model", o.model]),
    "--max-budget-usd",
    String(o.maxBudgetUsd),
  ];
}

/** Run claude to the end, or stop it at the deadline. */
function runClaude(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    let kill: NodeJS.Timeout | undefined;
    const stop = setTimeout(() => {
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(stop);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(stop);
      clearTimeout(kill);
      done({ code, out, err });
    });
  });
}

/**
 * A session's transcripts: the session's own, and any of its subagents'.
 *
 * @param configDir - where Claude Code keeps its sessions.
 * @param session - the session id.
 */
export function sessionTranscripts(
  configDir: string,
  session: string,
): string[] {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return [];
  for (const project of readdirSync(projects)) {
    const main = join(projects, project, `${session}.jsonl`);
    if (!existsSync(main)) continue;
    const subagents = join(projects, project, session, "subagents");
    return [
      main,
      ...(existsSync(subagents)
        ? readdirSync(subagents)
            .filter((f) => f.endsWith(".jsonl"))
            .sort()
            .map((f) => join(subagents, f))
        : []),
    ];
  }
  return [];
}

/** Tokens newly read or written, by the result's own count. */
export function resultTokens(
  result: ClaudeResult | undefined,
): number | undefined {
  const usage = result?.usage;
  if (usage === undefined) return undefined;
  const parts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.output_tokens,
  ].filter((n): n is number => typeof n === "number");
  return parts.length === 0 ? undefined : parts.reduce((a, b) => a + b, 0);
}

/** How long a reason may be before it stops being a reason and becomes output. */
const REASON_MAX_CHARS = 200;

/**
 * Why a session did not finish its turn, or undefined when it did.
 *
 * The client reports `is_error` and its own `terminal_reason` on every turn,
 * and `completed` is the one that ran to the end. Anything else - a provider
 * error, a usage limit, the turn cap, the harness stopping the agent - means
 * the session never got to do its work, so its tokens and its empty task list
 * say nothing about what the fleet can do (#133).
 *
 * @param result - what `claude -p --output-format json` printed.
 * @returns the reason, from the client's own words.
 */
export function sessionStop(result: ClaudeResult): string | undefined {
  const terminal = result.terminal_reason;
  const finished = terminal === undefined || terminal === "completed";
  if (finished && result.is_error !== true) return undefined;
  const said = typeof result.result === "string" ? result.result.trim() : "";
  const reason =
    (finished ? undefined : terminal) ??
    result.subtype ??
    (said === "" ? undefined : said.split(/\r?\n/)[0]);
  return reason?.slice(0, REASON_MAX_CHARS) ?? "an error with no reason given";
}

/** Claude Code, headless, with antibody's plugin. */
export function claudeDriver(o: ClaudeDriverOptions): Driver {
  const configDir =
    o.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return {
    capUsd: o.maxBudgetUsd,
    describe: (n) =>
      `${n} Claude Code ${n === 1 ? "agent" : "agents"}${o.model === undefined ? "" : ` (${o.model})`}`,
    async run(context) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
      };
      for (const name of PARENT_SESSION) delete env[name];
      const { code, out, err } = await runClaude(
        o.bin,
        claudeArgs(context, o),
        context.worktree,
        env,
        context.timeoutMs,
      );
      writeFileSync(join(context.runDir, `${context.session}.out.json`), out);
      let result: ClaudeResult | undefined;
      try {
        result = JSON.parse(out) as ClaudeResult;
      } catch {
        result = undefined;
      }
      if (result === undefined)
        throw new Error(
          `claude exited with ${code ?? "a signal"}: ${err.trim().split("\n").slice(-3).join(" | ") || "no output"}`,
        );

      // A session that dies on an API error or a usage limit still prints a
      // valid result object, so it belongs on the agent as an error rather
      // than in the table as a run that finished having done nothing (#133).
      const stopped = sessionStop(result);
      if (stopped !== undefined)
        throw new Error(`claude stopped before it worked: ${stopped}`);

      // The transcript is what antibody measures a diagnosis from; the
      // result's own count is the fallback.
      const transcripts = sessionTranscripts(configDir, context.session);
      let tokens: number | undefined;
      for (const [i, file] of transcripts.entries()) {
        copyFileSync(
          file,
          join(
            context.runDir,
            `${context.session}${i === 0 ? "" : `.${i}`}.jsonl`,
          ),
        );
        const n = tokensBetween(
          readFileSync(file, "utf8"),
          new Date(0),
          new Date(),
        );
        if (n !== undefined) tokens = (tokens ?? 0) + n;
      }
      const from = tokens === undefined ? "result" : "transcript";
      tokens ??= resultTokens(result);
      return {
        ...(tokens === undefined ? {} : { tokens }),
        details: {
          exitCode: code,
          tokensFrom: tokens === undefined ? "none" : from,
          transcripts: transcripts.length,
          ...(result.subtype === undefined ? {} : { subtype: result.subtype }),
          ...(result.is_error === undefined
            ? {}
            : { isError: result.is_error }),
          ...(result.terminal_reason === undefined
            ? {}
            : { terminalReason: result.terminal_reason }),
          ...(result.stop_reason === undefined || result.stop_reason === null
            ? {}
            : { stopReason: result.stop_reason }),
          ...(result.num_turns === undefined
            ? {}
            : { turns: result.num_turns }),
          ...(result.total_cost_usd === undefined
            ? {}
            : { costUsd: result.total_cost_usd }),
        },
      };
    },
  };
}
