// The Codex CLI adapter: hook payloads in, a HookInput out.
//
// Read off Codex CLI 0.160.1's source (codex-rs/hooks and codex-rs/core/src/
// tools). Codex runs Claude Code-style command hooks from hooks.json with one
// JSON object on stdin: `session_id`, `transcript_path`, `cwd`,
// `hook_event_name`, `model`, `turn_id`, and per event:
//
// - PostToolUse: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`,
//   and `agent_id` inside a subagent;
// - UserPromptSubmit: `prompt`; SessionStart: `source`; SessionEnd: `reason`.
//
// Two things differ from Claude Code. Codex has no PostToolUseFailure: a tool
// that fails outright runs no hook. And its shell tool, reported as `Bash`
// with `tool_input: { command }`, hands the hook the command's output as a
// string, without the exit code. So for Bash antibody infers a failure from
// the output (looksFailed()), and records it with exit code 1, since the real
// one is not known. An MCP tool result with `isError: true` is a failure too.
//
// The response is Claude Code's (hookResponse()): Codex reads
// `hookSpecificOutput.additionalContext` on SessionStart, UserPromptSubmit and
// PostToolUse. Parsing never throws.
import { withTranscript } from "./hook-input";
import type { HookEvent, HookInput } from "./hook-input";

/** The harness name, as agent names and events use it. */
export const CODEX = "codex";

/** Codex CLI's hook events antibody handles; they keep Claude Code's names. */
export const CODEX_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "SessionEnd",
];

/** The exit code an inferred shell failure is recorded with. */
export const INFERRED_EXIT_CODE = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A tool response as text: a string, content items, or JSON. */
function responseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(responseText).join("\n");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return responseText(value.content);
  }
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

// Lines that end a failed command's output. Only the last line is read: a
// successful command rarely ends on one, and a failed one usually does.
const FAILURE_LINES = [
  /^(?:error|fatal)(?:\[[\w-]+\])?:/i, // error: …, fatal: …, error[E0308]: …
  /^(?:[A-Z]\w*)?(?:Error|Exception)(?::|$)/, // TypeError: …, Error: …
  /\bcommand not found\b/,
  /: No such file or directory\b/,
  /: Permission denied\b/,
  /^npm ERR!/,
  /\bERR_PNPM_\w+/,
  /\bELIFECYCLE\b/,
  /^(?:FAIL|FAILED)\b/,
  /\b\d+ (?:failed|failing)\b/,
  /^make(?:\[\d+\])?: \*\*\*/,
];

// Commands that only show files or text: whatever their output says, it is
// what they were asked to print, not a failure.
const DISPLAY_COMMANDS = new Set([
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "grep",
  "egrep",
  "rg",
  "ag",
  "sed",
  "awk",
  "jq",
  "find",
  "ls",
  "tree",
  "echo",
  "printf",
  "wc",
  "diff",
]);
const DISPLAY_GIT = new Set(["log", "show", "diff", "grep", "blame"]);

/**
 * Whether a shell command's output reads like a failure, for a harness that
 * does not report the exit code: its last non-empty line names an error, and
 * the command is not one that only displays text.
 *
 * @param command - the command line, when known.
 * @param output - everything the command printed.
 */
export function looksFailed(
  command: string | undefined,
  output: string,
): boolean {
  const words = (command ?? "").trim().split(/\s+/);
  const first = words[0] ?? "";
  if (DISPLAY_COMMANDS.has(first)) return false;
  if (first === "git" && DISPLAY_GIT.has(words[1] ?? "")) return false;
  const last = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  return last !== undefined && FAILURE_LINES.some((re) => re.test(last));
}

/**
 * Parse a Codex CLI hook's stdin.
 *
 * @param text - the JSON Codex wrote.
 * @returns the hook call, or undefined for an event antibody does not handle
 *   or a payload it cannot read.
 */
export function parseCodexInput(text: string): HookInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const event = value.hook_event_name;
  const sessionId = str(value.session_id);
  const cwd = str(value.cwd);
  if (
    !(CODEX_EVENTS as readonly unknown[]).includes(event) ||
    sessionId === undefined ||
    sessionId === "" ||
    cwd === undefined
  )
    return undefined;

  const input = withTranscript(
    { event: event as HookEvent, sessionId, cwd },
    value,
  );
  if (event !== "PostToolUse") return input;

  const agentId = str(value.agent_id);
  if (agentId !== undefined && agentId !== "") input.agentId = agentId;
  const toolName = str(value.tool_name);
  if (toolName !== undefined) input.toolName = toolName;
  if (isRecord(value.tool_input)) {
    const command = str(value.tool_input.command);
    if (command !== undefined && command.trim() !== "") input.command = command;
  }
  const response = value.tool_response;
  const output = responseText(response);
  if (isRecord(response) && response.isError === true) {
    input.event = "PostToolUseFailure";
    input.error = output;
    return input;
  }
  input.output = output;
  if (toolName === "Bash" && looksFailed(input.command, output))
    input.exitCode = INFERRED_EXIT_CODE;
  return input;
}
