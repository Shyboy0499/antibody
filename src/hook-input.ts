// The hook call every harness adapter produces: the harness's payload,
// normalized to Claude Code's event names, and what the fleet loop needs from
// it. Each adapter parses its own payload into a HookInput (claude-code.ts,
// gemini.ts) and writes its own response; toCapture() and toToolCall() turn a
// HookInput into the capture input and tool call the fleet loop takes.
//
// A failed shell command arrives in one of three shapes, read in this order: a
// PostToolUse carrying a reported non-zero `exitCode`; a result or error text
// that starts with Claude Code's `Exit code N` - which is how a real Bash
// result reports a failure, on a PostToolUse as well as on a
// PostToolUseFailure; or a PostToolUse an adapter inferred a failure for
// (src/failure-hints.ts) when the harness reported no usable code at all, or a
// zero a pipeline's last stage earned (src/gemini.ts). All three become the
// `[exit code: N]` marker the ported capture code reads, so headline extraction
// and keying by command line work unchanged.
import { INFERRED_EXIT_CODE, benignExit } from "./failure-hints";
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
  /**
   * The session's transcript, as the harness names it: where the tokens a
   * diagnosis cost are read from (src/transcript.ts).
   */
  transcriptPath?: string;
  toolName?: string;
  /** The Bash command line, when the tool ran one. */
  command?: string;
  /** The tool call's id, which names its status file (src/pipefail.ts). */
  toolUseId?: string;
  /** Set when the command carried the shell wrapper (src/pipefail.ts). */
  wrapped?: boolean;
  /**
   * PostToolUse of a wrapped command: the first failure the shell recorded, when
   * the reported status said success (src/pipefail.ts).
   */
  maskedStatus?: number;
  /** PostToolUse: the tool's output as text. */
  output?: string;
  /**
   * PostToolUse: an exit code the result reports, when it has one.
   */
  exitCode?: number;
  /**
   * PostToolUse: the adapter read the output as a failure even though the
   * harness reported no code, or reported a zero that cannot speak for the
   * command - a pipeline's status is its last stage's. An inferred failure
   * never overrides a reported non-zero code.
   */
  inferredFailure?: boolean;
  /** PostToolUseFailure: the error text. */
  error?: string;
  /**
   * PostToolUseFailure: the call was interrupted - the user stopped it, or the
   * session did - rather than failing on its own, so there is nothing to learn
   * from it.
   */
  isInterrupt?: boolean;
}

/**
 * Add the transcript path a hook payload names, when it names one. Every
 * harness antibody serves sends `transcript_path` with every event.
 *
 * @param input - the hook call being read; changed in place.
 * @param payload - the harness's hook payload.
 * @returns the same hook call.
 */
export function withTranscript(
  input: HookInput,
  payload: Readonly<Record<string, unknown>>,
): HookInput {
  const path = payload.transcript_path;
  if (typeof path === "string" && path.trim() !== "")
    input.transcriptPath = path;
  return input;
}

// The wordings a failed shell command's exit code arrives in, each leading the
// text. Claude Code throws `Exit code N` for a Bash call that fails; the
// classifier inside its own Bash tool (read off the 2.1.282 bundle) words the
// same failure `Command failed with exit code N`, and its hooks reference
// shows `Command exited with non-zero status code N` as the `error` example.
const EXIT_LINE =
  /^(?:Exit code |Command failed with exit code |Command exited with non-zero status code )(\d+)[^\S\n]*\n?/;

// Text in the shape the ported capture code reads: the output, then the marker.
const withMarker = (body: string, code: number) =>
  `${body.trimEnd()}\n[exit code: ${code}]`;

/**
 * The exit code and output of a failed shell command, when the call is one.
 *
 * A code the harness reports is believed as it stands - a reported zero is a
 * success, never second-guessed - with one exception: a zero the adapter read
 * the output as a failure against, which is a pipeline whose last stage
 * succeeded while the command failed (#131). Without a code, Claude Code's
 * `Exit code N` is read from wherever the harness put the text, and only then is
 * an inferred failure accepted.
 */
function commandFailure(
  input: HookInput,
): { code: number; body: string } | undefined {
  const failed = input.event === "PostToolUseFailure";
  if (!failed && input.event !== "PostToolUse") return undefined;
  // The shell's own record of a failure it did not report (src/pipefail.ts).
  if (!failed && input.maskedStatus !== undefined)
    return { code: input.maskedStatus, body: input.output ?? "" };
  if (input.exitCode !== undefined) {
    // A code the harness reports is believed as it stands, with one exception:
    // a zero does not settle a call an adapter read as a failure, because the
    // zero a pipeline reports is its last command's, not the command's
    // (src/gemini.ts, #131).
    if (input.exitCode === 0) {
      if (input.inferredFailure !== true) return undefined;
      return { code: INFERRED_EXIT_CODE, body: input.output ?? "" };
    }
    // The harness says what the code means for a `grep` and the like: 1 is
    // "no matches", not a failure.
    if (input.exitCode === 1 && benignExit(input.command)) return undefined;
    return { code: input.exitCode, body: input.output ?? "" };
  }
  const text = failed ? (input.error ?? "") : (input.output ?? "");
  const match = EXIT_LINE.exec(text);
  if (match !== null) {
    const rest = text.slice(match[0].length);
    // A one-line wording carries no output of its own: keep it as the
    // evidence rather than leaving the record without a headline.
    return {
      code: Number(match[1]),
      body: rest.trim() === "" ? text : rest,
    };
  }
  if (input.event === "PostToolUse" && input.inferredFailure === true)
    return { code: INFERRED_EXIT_CODE, body: input.output ?? "" };
  return undefined;
}

/**
 * The capture input for a failed call, or undefined when the call succeeded,
 * was interrupted, or the event is not a tool result.
 *
 * @param input - a parsed hook call.
 */
export function toCapture(input: HookInput): CaptureInput | undefined {
  if (input.isInterrupt === true) return undefined;
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
