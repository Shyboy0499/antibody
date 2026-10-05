// The Gemini CLI adapter: hook payloads in, a HookInput out, and the response.
//
// Read off Gemini CLI 0.62.0's source (packages/core/src/hooks). A command hook
// gets one JSON object on stdin with `session_id`, `transcript_path`, `cwd`,
// `hook_event_name` and `timestamp`, plus, per event:
//
// - AfterTool: `tool_name`, `tool_input`, and `tool_response`, an object with
//   `llmContent` (what the model reads), `returnDisplay` and, when the tool
//   failed, `error: { message, type }`;
// - BeforeAgent: `prompt`, before the model sees the user's prompt;
// - SessionStart: `source`; SessionEnd: `reason`.
//
// These map onto Claude Code's event names: BeforeAgent is a new turn, and
// AfterTool is a PostToolUse, or a PostToolUseFailure when the tool reported
// an error.
//
// A shell command that exits non-zero is not an error to Gemini. Its result is
// `Output: …`, then `Error: …`, `Exit Code: N` and process lines, inside an
// `<untrusted_context>` wrapper, so run_shell_command results are read for
// the exit code and stripped down to the command's own output.
//
// Gemini reads `hookSpecificOutput.additionalContext` from stdout on AfterTool
// (appended to the tool result), BeforeAgent (appended to the prompt) and
// SessionStart (put before the first prompt). Parsing never throws.
import type { HookEvent, HookInput } from "./hook-input";
import { clip } from "./notice";

/** The harness name, as agent names and events use it. */
export const GEMINI = "gemini";

/** Gemini CLI's hook events antibody handles, and what each one is to antibody. */
export const GEMINI_EVENTS = {
  SessionStart: "SessionStart",
  BeforeAgent: "UserPromptSubmit",
  AfterTool: "PostToolUse",
  SessionEnd: "SessionEnd",
} as const satisfies Record<string, HookEvent>;

export type GeminiEvent = keyof typeof GEMINI_EVENTS;

/** Gemini CLI's names for its shell tool. */
export const GEMINI_SHELL_TOOLS = ["run_shell_command", "ShellTool"];

// Error types Gemini reports that are not failures to learn from: a request to
// widen the sandbox, a hook that stopped the agent, and a policy denial.
const NOT_FAILURES = new Set([
  "sandbox_expansion_required",
  "stop_execution",
  "policy_violation",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** `llmContent` as text: a string, a part, or a list of parts. */
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).join("\n");
  if (isRecord(value)) return str(value.text) ?? JSON.stringify(value);
  return "";
}

const UNTRUSTED =
  /^\s*<untrusted_context>\n?([\s\S]*?)\n?<\/untrusted_context>\s*$/;
const EXIT_CODE = /^Exit Code: (-?\d+)\s*$/m;
const PROCESS_LINES =
  /^(?:Exit Code|Signal|Background PIDs|Process Group PGID): .*(?:\n|$)/gm;

/**
 * A shell tool's result: its exit code, when it reports one, and the command's
 * own output and error lines without Gemini's labels and process details.
 */
export function shellResult(text: string): {
  exitCode?: number;
  output: string;
} {
  const body = UNTRUSTED.exec(text)?.[1] ?? text;
  const match = EXIT_CODE.exec(body);
  const output = body
    .replace(PROCESS_LINES, "")
    .replace(/^Output: (?:\(empty\))?/, "")
    .trim();
  return match === null ? { output } : { exitCode: Number(match[1]), output };
}

/**
 * Parse a Gemini CLI hook's stdin.
 *
 * @param text - the JSON Gemini CLI wrote.
 * @returns the hook call in Claude Code's terms, or undefined for an event
 *   antibody does not handle or a payload it cannot read.
 */
export function parseGeminiInput(text: string): HookInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const native = value.hook_event_name;
  const sessionId = str(value.session_id);
  const cwd = str(value.cwd);
  if (
    typeof native !== "string" ||
    !Object.hasOwn(GEMINI_EVENTS, native) ||
    sessionId === undefined ||
    sessionId === "" ||
    cwd === undefined
  )
    return undefined;

  const input: HookInput = {
    event: GEMINI_EVENTS[native as GeminiEvent],
    sessionId,
    cwd,
  };
  if (native !== "AfterTool") return input;

  const toolName = str(value.tool_name);
  if (toolName !== undefined) input.toolName = toolName;
  if (isRecord(value.tool_input)) {
    const command = str(value.tool_input.command);
    if (command !== undefined && command.trim() !== "") input.command = command;
  }
  const response = isRecord(value.tool_response) ? value.tool_response : {};
  const content = contentText(response.llmContent);
  const error = isRecord(response.error) ? response.error : undefined;
  if (error !== undefined && !NOT_FAILURES.has(str(error.type) ?? "")) {
    input.event = "PostToolUseFailure";
    input.error = str(error.message) ?? content;
    return input;
  }
  if (toolName !== undefined && GEMINI_SHELL_TOOLS.includes(toolName)) {
    const shell = shellResult(content);
    input.output = shell.output;
    if (shell.exitCode !== undefined) input.exitCode = shell.exitCode;
    return input;
  }
  input.output = content;
  return input;
}

/** The most context one response carries: the same limit as for Claude Code. */
export const GEMINI_CONTEXT_MAX_CHARS = 10_000;

// antibody's event, as the Gemini event that carries context for it.
const NATIVE: Partial<Record<HookEvent, GeminiEvent>> = {
  SessionStart: "SessionStart",
  UserPromptSubmit: "BeforeAgent",
  PostToolUse: "AfterTool",
  PostToolUseFailure: "AfterTool",
};

/**
 * The stdout for a Gemini CLI hook: the notices as
 * `hookSpecificOutput.additionalContext`, one per line, or the empty string
 * when there is nothing to say or the event cannot carry context.
 *
 * @param event - the event the hook answers, in antibody's terms.
 * @param notices - notice bodies, each already inside the notice caps.
 */
export function geminiResponse(
  event: HookEvent,
  notices: readonly string[],
): string {
  const lines = notices.filter((n) => n.trim() !== "");
  const native = NATIVE[event];
  if (lines.length === 0 || native === undefined) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: native,
      additionalContext: clip(lines.join("\n"), GEMINI_CONTEXT_MAX_CHARS),
    },
  });
}
