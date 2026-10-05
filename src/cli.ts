// The antibody command line.
//
//   antibody hook claude-code   handle one Claude Code hook call (stdin JSON)
//   antibody hook gemini        handle one Gemini CLI hook call (stdin JSON)
//   antibody hook codex         handle one Codex CLI hook call (stdin JSON)
//   antibody mcp [harness]      serve the agent tools over MCP on stdio
//   antibody setup gemini       add the hooks and MCP server to Gemini CLI
//   antibody setup codex        add the hooks to Codex CLI
//   antibody stats              print the memory's ledger, for people and scripts
//   antibody --version          print the version
//
// A hook must never break or block the agent it runs in, so `hook` fails open:
// outside a git repository, on a payload it cannot read, on any internal error,
// or when it runs past its deadline, it prints nothing and exits 0, which
// leaves Claude Code's behaviour unchanged. ANTIBODY_DEBUG=1 reports errors on
// stderr.
import { agentName, worktreeRoot } from "./agent";
import { CLAUDE_CODE, hookResponse, parseHookInput } from "./claude-code";
import { toCapture, toToolCall } from "./hook-input";
import type { HookEvent, HookInput } from "./hook-input";
import { CODEX, parseCodexInput } from "./codex";
import { createFleet } from "./fleet";
import { GEMINI, geminiResponse, parseGeminiInput } from "./gemini";
import type { Fleet } from "./fleet";
import { createMcpServer, serveLines } from "./mcp";
import { memoryDir } from "./paths";
import type { ToolCall } from "./resolve-detect";
import type { GitRunner } from "./paths";
import { runSetup } from "./setup";
import type { SetupDeps } from "./setup";
import { createTools } from "./tools";
import type { Tool } from "./tools";

/** The version `antibody --version` prints. */
export const VERSION = "0.0.0";

/** A hook call that takes longer than this prints nothing. */
export const HOOK_DEADLINE_MS = 3_000;

/** Where the command line reads and writes; injected in tests. */
export interface CliIo {
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
}

/** What the hook command needs from the machine; injected in tests. */
export interface HookDeps {
  git?: GitRunner;
  deadlineMs?: number;
  fleet?: (memory: string, agent: string, session: string) => Fleet;
}

/** What the mcp command needs from the machine; injected in tests. */
export interface McpDeps {
  git?: GitRunner;
  /** The message stream; process.stdin by default. */
  input?: NodeJS.ReadableStream;
  /** The working directory; process.cwd() by default. */
  cwd?: string;
  pid?: number;
}

/** One harness's hook protocol: its payload in, its response out. */
export interface HookAdapter {
  parse(text: string): HookInput | undefined;
  respond(event: HookEvent, notices: readonly string[]): string;
}

/** The harnesses `antibody hook` serves, by the name it is called with. */
export const HOOK_ADAPTERS: Readonly<Record<string, HookAdapter>> = {
  [CLAUDE_CODE]: { parse: parseHookInput, respond: hookResponse },
  [GEMINI]: { parse: parseGeminiInput, respond: geminiResponse },
  // Codex answers the way Claude Code does.
  [CODEX]: { parse: parseCodexInput, respond: hookResponse },
};

/** A harness name as `antibody mcp` accepts it: it becomes part of agent names. */
const HARNESS_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Route one hook call into the fleet loop.
 *
 * @param input - the parsed hook call.
 * @param fleet - the session's fleet loop.
 * @returns the notices for the agent.
 */
export async function dispatch(
  input: HookInput,
  fleet: Fleet,
): Promise<string[]> {
  switch (input.event) {
    case "SessionStart":
      return fleet.poll();
    case "UserPromptSubmit":
      return fleet.beginTurn();
    case "SessionEnd":
      await fleet.endSession();
      return [];
    case "PostToolUse":
    case "PostToolUseFailure": {
      // A tool event always maps to a tool call.
      const call = toToolCall(input) as ToolCall;
      const capture = toCapture(input);
      return capture === undefined
        ? fleet.success(call)
        : fleet.failure(capture, call);
    }
  }
}

const TIMEOUT = Symbol("timeout");

/**
 * `antibody hook <harness>`: handle one hook call. Always exits 0.
 *
 * @param harness - the harness whose hook called, a key of HOOK_ADAPTERS.
 * @param io - stdin, stdout, stderr and the environment.
 * @param deps - git, the deadline and the fleet factory.
 */
export async function runHook(
  harness: string,
  io: CliIo,
  deps: HookDeps = {},
): Promise<number> {
  const debug = io.env.ANTIBODY_DEBUG === "1";
  let timer: NodeJS.Timeout | undefined;
  const work = async (): Promise<string> => {
    const adapter = Object.hasOwn(HOOK_ADAPTERS, harness)
      ? HOOK_ADAPTERS[harness]
      : undefined;
    if (adapter === undefined) throw new Error(`unknown harness: ${harness}`);
    const input = adapter.parse(await io.readStdin());
    if (input === undefined) return "";
    let memory: string;
    try {
      memory = memoryDir(input.cwd, deps.git, io.env);
    } catch {
      return "";
    }
    const agent = agentName(harness, worktreeRoot(input.cwd, deps.git), io.env);
    const fleet = (deps.fleet ?? ((m, a, s) => createFleet(m, a, s)))(
      memory,
      agent,
      input.sessionId,
    );
    return adapter.respond(input.event, await dispatch(input, fleet));
  };
  try {
    const deadline = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(
        () => resolve(TIMEOUT),
        deps.deadlineMs ?? HOOK_DEADLINE_MS,
      );
      timer.unref?.();
    });
    const out = await Promise.race([work(), deadline]);
    if (out === TIMEOUT) {
      if (debug)
        io.stderr("antibody: hook ran past its deadline; said nothing\n");
    } else if (out !== "") io.stdout(out);
  } catch (error) {
    if (debug)
      io.stderr(
        `antibody: ${error instanceof Error ? error.message : String(error)}\n`,
      );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return 0;
}

const USAGE = `usage: antibody hook claude-code   handle one Claude Code hook call
       antibody hook gemini        handle one Gemini CLI hook call
       antibody hook codex         handle one Codex CLI hook call
       antibody mcp [harness]      serve the agent tools over MCP on stdio
       antibody setup gemini       add the hooks and MCP server to Gemini CLI
       antibody setup codex        add the hooks to Codex CLI
       antibody stats              print the memory's ledger for this repository
       antibody --version
`;

/**
 * `antibody mcp [harness]`: serve the agent tools to one agent until stdin
 * ends. The harness names the agent the way its hooks do, so a fix recorded
 * through the tools is credited to the same agent in the event log; it
 * defaults to "mcp".
 *
 * Claude Code starts a stdio server in the project directory and passes
 * CLAUDE_PROJECT_DIR and CLAUDE_CODE_SESSION_ID, so the server finds the same
 * memory as the hooks and logs under the same session. Other harnesses get
 * the working directory and a session named after the process.
 *
 * @param harness - the harness name, or "" for the default.
 * @param io - stdout for responses, stderr for usage errors, the environment.
 * @param deps - the input stream, the directory, git; injected in tests.
 * @returns the exit code once stdin ends.
 */
export async function runMcp(
  harness: string,
  io: CliIo,
  deps: McpDeps = {},
): Promise<number> {
  const name = harness === "" ? "mcp" : harness;
  if (!HARNESS_NAME.test(name)) {
    io.stderr(`antibody: not a harness name: ${harness}\n${USAGE}`);
    return 2;
  }
  const cwd = deps.cwd ?? (io.env.CLAUDE_PROJECT_DIR || process.cwd());
  const tools = createTools({
    memory: () => memoryDir(cwd, deps.git, io.env),
    agent: agentName(name, worktreeRoot(cwd, deps.git), io.env),
    session: io.env.CLAUDE_CODE_SESSION_ID || `mcp-${deps.pid ?? process.pid}`,
  });
  const server = createMcpServer(tools, { name: "antibody", version: VERSION });
  await serveLines(server, deps.input ?? process.stdin, io.stdout);
  return 0;
}

/**
 * `antibody stats`: print the antibody_stats ledger for the repository the
 * working directory is in: entries, hits, notices and the tokens they saved,
 * what is being diagnosed, distrusted fixes.
 *
 * @param args - the arguments after `stats`; none are taken.
 * @param io - stdout for the ledger, stderr for errors, the environment.
 * @param deps - the working directory and git; injected in tests.
 * @returns 0, 1 when the memory cannot be read, 2 on usage.
 */
export async function runStats(
  args: readonly string[],
  io: CliIo,
  deps: McpDeps = {},
): Promise<number> {
  if (args.length > 0) {
    io.stderr(`antibody: stats takes no arguments\n${USAGE}`);
    return 2;
  }
  const cwd = deps.cwd ?? process.cwd();
  const [stats] = createTools({
    memory: () => memoryDir(cwd, deps.git, io.env),
    agent: agentName("cli", worktreeRoot(cwd, deps.git), io.env),
    session: `cli-${deps.pid ?? process.pid}`,
  }).filter((tool) => tool.name === "antibody_stats");
  const result = await (stats as Tool).call({});
  if (result.isError) {
    io.stderr(`antibody: ${result.text.replace(/^antibody_stats: /, "")}\n`);
    return 1;
  }
  io.stdout(`${result.text}\n`);
  return 0;
}

/**
 * The command line's entry point.
 *
 * @param argv - the arguments after the program name.
 * @param io - stdin, stdout, stderr and the environment.
 * @param deps - passed to the hook and mcp commands.
 * @returns the exit code.
 */
export async function main(
  argv: readonly string[],
  io: CliIo,
  deps: HookDeps & McpDeps & SetupDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "hook") return runHook(rest[0] ?? "", io, deps);
  if (command === "mcp") return runMcp(rest[0] ?? "", io, deps);
  if (command === "setup") return runSetup(rest, io, deps);
  if (command === "stats") return runStats(rest, io, deps);
  if (command === "--version" || command === "-v") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === undefined) {
    io.stdout(USAGE);
    return command === undefined ? 2 : 0;
  }
  io.stderr(`antibody: unknown command: ${command}\n${USAGE}`);
  return 2;
}
