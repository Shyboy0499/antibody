// The antibody command line.
//
//   antibody hook claude-code   handle one Claude Code hook call (stdin JSON)
//   antibody --version          print the version
//
// A hook must never break or block the agent it runs in, so `hook` fails open:
// outside a git repository, on a payload it cannot read, on any internal error,
// or when it runs past its deadline, it prints nothing and exits 0, which
// leaves Claude Code's behaviour unchanged. ANTIBODY_DEBUG=1 reports errors on
// stderr.
import { agentName, worktreeRoot } from "./agent";
import {
  CLAUDE_CODE,
  hookResponse,
  parseHookInput,
  toCapture,
  toToolCall,
} from "./claude-code";
import type { HookInput } from "./claude-code";
import { createFleet } from "./fleet";
import type { Fleet } from "./fleet";
import { memoryDir, runGit } from "./paths";
import type { ToolCall } from "./resolve-detect";
import type { GitRunner } from "./paths";

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
 * @param harness - the harness whose hook called; only `claude-code` today.
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
    if (harness !== CLAUDE_CODE) throw new Error(`unknown harness: ${harness}`);
    const input = parseHookInput(await io.readStdin());
    if (input === undefined) return "";
    const git = deps.git ?? runGit;
    let memory: string;
    try {
      memory = memoryDir(input.cwd, git);
    } catch {
      return "";
    }
    const agent = agentName(CLAUDE_CODE, worktreeRoot(input.cwd, git), io.env);
    const fleet = (deps.fleet ?? ((m, a, s) => createFleet(m, a, s)))(
      memory,
      agent,
      input.sessionId,
    );
    return hookResponse(input.event, await dispatch(input, fleet));
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
       antibody --version
`;

/**
 * The command line's entry point.
 *
 * @param argv - the arguments after the program name.
 * @param io - stdin, stdout, stderr and the environment.
 * @param deps - passed to the hook command.
 * @returns the exit code.
 */
export async function main(
  argv: readonly string[],
  io: CliIo,
  deps: HookDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "hook") return runHook(rest[0] ?? "", io, deps);
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
