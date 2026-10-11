// The Claude Code adapter: hook payloads in, capture inputs and tool calls out.
//
// Claude Code runs a command hook with one JSON object on stdin. The fields
// antibody reads, from the hooks reference and the 2.1.282 bundle:
//
// - every event: `hook_event_name`, `session_id`, `cwd`, and `agent_id` inside
//   a subagent;
// - PostToolUse: `tool_name`, `tool_input`, and the result as `tool_response`
//   (older versions call it `tool_output`, sometimes an object);
// - PostToolUseFailure: `tool_name`, `tool_input`, `error` and `is_interrupt`;
//   it carries no result, and PostToolUse carries no `error`.
//
// A real Bash result holds `stdout`, `stderr`, `interrupted`, `timedOutAfterMs`
// and `noOutputExpected` - no numeric exit code, so outputExitCode() below
// never reads one for this harness. A failed Bash command reports `Exit code N`
// at the start of its result text instead, which toCapture() in hook-input.ts
// turns into the capture code's marker. A pipeline reports its last command's
// status, so `npm test 2>&1 | tail -15` arrives as a successful PostToolUse
// with no code anywhere (#131); a Bash result that names no code but ends on an
// error line is therefore inferred as a failure (looksFailed(),
// src/failure-hints.ts). Parsing never throws: anything unexpected reads as
// undefined.
//
// Output goes back the documented way: JSON on stdout with
// `hookSpecificOutput.additionalContext`, which Claude Code shows the model as
// a system reminder, or nothing at all.
import { looksFailed } from "./failure-hints";
import { HOOK_EVENTS, withTranscript } from "./hook-input";
import type { HookEvent, HookInput } from "./hook-input";
import { isWrapped, unwrapCommand } from "./pipefail";
import { clip } from "./notice";

/** The harness name, as agent names and events use it. */
export const CLAUDE_CODE = "claude-code";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// A result object as text: a shell's stdout and stderr, else its JSON.
function outputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const streams = [str(value.stdout), str(value.stderr)].filter(
      (s): s is string => s !== undefined && s !== "",
    );
    if (streams.length > 0) return streams.join("\n");
  }
  return JSON.stringify(value);
}

const EXIT_KEYS = ["exitCode", "exit_code", "returnCode", "return_code"];

function outputExitCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of EXIT_KEYS) {
    const n = value[key];
    if (typeof n === "number" && Number.isInteger(n)) return n;
  }
  return undefined;
}

/**
 * Parse a hook's stdin.
 *
 * @param text - the JSON Claude Code wrote.
 * @returns the hook call, or undefined for an event antibody does not handle
 *   or a payload it cannot read.
 */
export function parseHookInput(text: string): HookInput | undefined {
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
    !(HOOK_EVENTS as readonly unknown[]).includes(event) ||
    sessionId === undefined ||
    sessionId === "" ||
    cwd === undefined
  )
    return undefined;

  const input = withTranscript(
    { event: event as HookEvent, sessionId, cwd },
    value,
  );
  const agentId = str(value.agent_id);
  if (agentId !== undefined && agentId !== "") input.agentId = agentId;
  const toolName = str(value.tool_name);
  if (toolName !== undefined) input.toolName = toolName;
  if (isRecord(value.tool_input)) {
    const command = str(value.tool_input.command);
    // The command the agent wrote, without the wrapper the PreToolUse rewrite
    // adds around it (src/pipefail.ts), so the same command keeps one signature.
    if (command !== undefined && command.trim() !== "") {
      input.command = unwrapCommand(command);
      if (isWrapped(command)) input.wrapped = true;
    }
  }
  const toolUseId = str(value.tool_use_id);
  if (toolUseId !== undefined && toolUseId !== "") input.toolUseId = toolUseId;
  const result = value.tool_output ?? value.tool_response;
  const output = outputText(result);
  if (output !== undefined) input.output = output;
  const exitCode = outputExitCode(result);
  if (exitCode !== undefined) input.exitCode = exitCode;
  const error = str(value.error);
  if (error !== undefined) input.error = error;
  if (value.is_interrupt === true) input.isInterrupt = true;
  if (
    event === "PostToolUse" &&
    toolName === "Bash" &&
    input.command !== undefined &&
    input.exitCode === undefined &&
    looksFailed(input.command, input.output ?? "")
  )
    input.inferredFailure = true;
  return input;
}

/** Claude Code caps each additionalContext at this many characters. */
export const ADDITIONAL_CONTEXT_MAX_CHARS = 10_000;

/** The events whose hook output can carry additionalContext. */
const CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
]);

/**
 * The stdout for a hook: the notices as `hookSpecificOutput.additionalContext`,
 * one per line, or the empty string when there is nothing to say or the event
 * cannot carry context. An empty stdout with exit code 0 leaves Claude Code's
 * behaviour unchanged.
 *
 * @param event - the event the hook answers.
 * @param notices - notice bodies, each already inside the notice caps.
 */
export function hookResponse(
  event: HookEvent,
  notices: readonly string[],
): string {
  const lines = notices.filter((n) => n.trim() !== "");
  if (lines.length === 0 || !CONTEXT_EVENTS.has(event)) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: clip(lines.join("\n"), ADDITIONAL_CONTEXT_MAX_CHARS),
    },
  });
}
