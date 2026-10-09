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
// the output with the rule shared by the adapters (src/failure-hints.ts), and
// records it with exit code 1, since the real one is not known. An MCP tool
// result with `isError: true` is a failure too.
//
// The response is Claude Code's (hookResponse()): Codex reads
// `hookSpecificOutput.additionalContext` on SessionStart, UserPromptSubmit and
// PostToolUse. Parsing never throws.
import { INFERRED_EXIT_CODE, looksFailed } from "./failure-hints";
import { withTranscript } from "./hook-input";
import type { HookEvent, HookInput } from "./hook-input";

// Re-exported: callers reached the shared rule through this adapter's module
// before it moved to src/failure-hints.ts.
export { INFERRED_EXIT_CODE, looksFailed };

/** The harness name, as agent names and events use it. */
export const CODEX = "codex";

/** Codex CLI's hook events antibody handles; they keep Claude Code's names. */
export const CODEX_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "SessionEnd",
];

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
