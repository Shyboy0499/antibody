// The hook call every harness adapter produces: the harness's payload,
// normalized to Claude Code's event names, and what the fleet loop needs from
// it. Each adapter parses its own payload into a HookInput (claude-code.ts,
// gemini.ts) and writes its own response; toCapture() and toToolCall() turn a
// HookInput into the capture input and tool call the fleet loop takes.
//
// A failed shell command arrives either as a PostToolUseFailure whose error
// starts with Claude Code's `Exit code N`, or as a PostToolUse with an
// `exitCode`. Both become the `[exit code: N]` marker the ported capture code
// reads, so headline extraction and keying by command line work unchanged.
import type { CaptureInput } from "./capture";
import type { ToolCall } from "./resolve-detect";

/** The hook events antibody handles. */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** One hook call, reduced to what antibody reads. */
export interface HookInput {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  /** Set when the hook fired inside a subagent. */
  agentId?: string;
  toolName?: string;
  /** The Bash command line, when the tool ran one. */
  command?: string;
  /** PostToolUse: the tool's output as text. */
  output?: string;
  /** PostToolUse: an exit code the result reports, when it has one. */
  exitCode?: number;
  /** PostToolUseFailure: the error text. */
  error?: string;
}

// Claude Code's own wording for a failed shell command.
const EXIT_LINE = /^Exit code (\d+)[^\S\n]*\n?/;

// Text in the shape the ported capture code reads: the output, then the marker.
const withMarker = (body: string, code: number) =>
  `${body.trimEnd()}\n[exit code: ${code}]`;

/** The exit code and output of a failed shell command, when the call is one. */
function commandFailure(
  input: HookInput,
): { code: number; body: string } | undefined {
  if (input.event === "PostToolUseFailure") {
    const match = EXIT_LINE.exec(input.error ?? "");
    if (match === null) return undefined;
    return {
      code: Number(match[1]),
      body: (input.error ?? "").slice(match[0].length),
    };
  }
  if (
    input.event === "PostToolUse" &&
    input.exitCode !== undefined &&
    input.exitCode !== 0
  )
    return { code: input.exitCode, body: input.output ?? "" };
  return undefined;
}

/**
 * The capture input for a failed call, or undefined when the call succeeded or
 * the event is not a tool result.
 *
 * @param input - a parsed hook call.
 */
export function toCapture(input: HookInput): CaptureInput | undefined {
  const toolName = input.toolName ?? "unknown";
  const failed = commandFailure(input);
  if (failed !== undefined) {
    const capture: CaptureInput = {
      kind: "command",
      toolName,
      text: withMarker(failed.body, failed.code),
    };
    if (input.command !== undefined) capture.command = input.command;
    return capture;
  }
  if (input.event !== "PostToolUseFailure") return undefined;
  return { kind: "tool", toolName, isError: true, message: input.error ?? "" };
}

/**
 * The tool call resolution detection reads, for a PostToolUse or a
 * PostToolUseFailure; undefined for any other event.
 *
 * @param input - a parsed hook call.
 */
export function toToolCall(input: HookInput): ToolCall | undefined {
  if (input.event !== "PostToolUse" && input.event !== "PostToolUseFailure")
    return undefined;
  const call: ToolCall = {
    toolName: input.toolName ?? "unknown",
    isError: false,
    text: input.output ?? "",
  };
  if (input.command !== undefined) call.command = input.command;
  const failed = commandFailure(input);
  if (failed !== undefined) call.text = withMarker(failed.body, failed.code);
  else if (input.event === "PostToolUseFailure") {
    call.isError = true;
    call.text = input.error ?? "";
  }
  return call;
}
