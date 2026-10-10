// The PreToolUse rewrite, for Bash commands whose own status is not the whole
// story (#131).
//
// A shell reports the last command's status: for a pipeline (`npm test 2>&1 |
// tail -15`) and for a `;` chain (`npm test; echo done`) alike. So a failure
// anywhere else in the command line reaches the hooks as a success, and Claude
// Code reports no exit code for a Bash result at all (src/claude-code.ts).
//
// The hook wraps such a command in a DEBUG trap instead of an ERR trap. A DEBUG
// trap runs before every simple command and sees the status of the one before
// it, so each command's failure is noticed, whatever the shell does with the
// command's own status. Claude Code's client runs its own `[[ … ]]` checks
// between commands, which exit 1 on Linux and must not count, so they are left
// out, and so is a grep, diff or test that exited 1 for "no match".
//
// The first failure's status is written to a file named after the tool call
// (tool_use_id), which the PostToolUse hook reads. The command's own status is
// passed on unchanged, so what the agent and Claude Code see is what an
// unwrapped command would show.
//
// Set ANTIBODY_PIPEFAIL=0 to turn the rewrite off.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";

/** The environment variable that turns the rewrite off when set to 0. */
export const PIPEFAIL_ENV = "ANTIBODY_PIPEFAIL";

/** The harness name the PreToolUse hook is registered under. */
export const PRE_TOOL_HARNESS = "claude-code-pretool";

/** The prefix the rewrite used before the DEBUG trap (#143, #150); still taken off. */
export const LEGACY_PREFIX = "set -o pipefail; ";

/** What the rewrite puts in front of a command, all on one line. */
export const REWRITE_PREFIX = String.raw`set -o pipefail 2>/dev/null; __antibody_f=0; __antibody_lb=0; __antibody_p=; trap '__antibody_s=$?; if [ -n "$__antibody_p" ]; then case $__antibody_p in "[["*) ;; grep\ *|grep|egrep\ *|egrep|fgrep\ *|fgrep|rg\ *|rg|find\ *|find|diff\ *|diff|test\ *|test|\[\ *|\[) if [ $__antibody_s -eq 1 ]; then __antibody_lb=1; elif [ $__antibody_s -gt 1 ]; then __antibody_f=$__antibody_s; __antibody_lb=0; fi;; *) if [ $__antibody_s -ne 0 ]; then __antibody_f=$__antibody_s; __antibody_lb=0; fi;; esac; fi; __antibody_p=$BASH_COMMAND' DEBUG 2>/dev/null; `;

/** The epilogue's first line, which unwrapCommand() looks for. */
const EPILOGUE_MARK = "\n__antibody_last=$?;";

// A pipe between two stages, and not a shell `||`: `a | b` is a pipeline,
// `a || b` is not, and neither is a `2>&1` redirection.
const PIPELINE = /(^|[^|])\|([^|]|$)/;

// More than one command at the top level: `;`, a newline, a pipe (or `||`), or
// an `&` that is not a redirection's `2>&1`. The reading is textual - a `;`
// inside quotes counts - and wrapping a command that turns out to be one
// command anyway costs nothing, because the epilogue then passes its status on.
const COMPOUND = /[;\n|]|&(?!\d)/;

// The names the rewrite uses. A command that already carries one is left alone:
// the rewrite is then idempotent, and unwrapCommand() has nothing to guess.
const MARKER = "__antibody_";

/**
 * Whether a command line holds a pipeline, as the rewrite tells one.
 *
 * @param command - a shell command line.
 */
export function hasPipeline(command: string): boolean {
  return PIPELINE.test(command);
}

/**
 * Whether the shell's own status for this command line cannot speak for all of
 * it, because it holds more than one command.
 *
 * @param command - a shell command line.
 */
export function needsRewrite(command: string): boolean {
  return COMPOUND.test(command);
}

/** The directory the status files are kept in. */
export const STATUS_DIR = join(tmpdir(), "antibody-status");

/**
 * The file a tool call's status is written to, or undefined for an id that is
 * not a plain token (so nothing is written under an unexpected name).
 *
 * @param toolUseId - the id Claude Code gives the tool call.
 */
export function statusPathFor(toolUseId: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId)) return undefined;
  return join(STATUS_DIR, `${toolUseId}.status`);
}

/**
 * The command as the shell must run it: wrapped, so a failure anywhere in it is
 * noted in the status file. Undefined when it needs none: one command, already
 * wrapped, or the rewrite is switched off.
 *
 * @param command - the Bash command the agent wrote.
 * @param statusPath - where the failure's status is written, if anywhere.
 * @param env - the environment; ANTIBODY_PIPEFAIL=0 switches the rewrite off.
 */
export function rewriteCommand(
  command: string,
  statusPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env[PIPEFAIL_ENV] === "0") return undefined;
  if (!needsRewrite(command)) return undefined;
  if (command.includes(MARKER)) return undefined;
  const write =
    statusPath === undefined
      ? ""
      : ` mkdir -p "${STATUS_DIR}" 2>/dev/null; printf '%s' "$__antibody_f" > "${statusPath}" 2>/dev/null;`;
  return `${REWRITE_PREFIX}${command}${EPILOGUE_MARK} trap - DEBUG; if [ "$__antibody_last" -eq 1 ] && [ "$__antibody_lb" -eq 1 ] && [ "$__antibody_f" -eq 0 ]; then __antibody_last=0; fi;${write} ( exit "$__antibody_last" )`;
}

/**
 * Whether a command carries the rewrite, as the hook reads it back.
 *
 * @param command - the command as a PostToolUse payload carries it.
 */
export function isWrapped(command: string): boolean {
  return (
    command.startsWith(REWRITE_PREFIX) || command.startsWith(LEGACY_PREFIX)
  );
}

/**
 * The command the agent wrote, from the command a PostToolUse payload carries:
 * the rewrite taken off again, so one command keeps one signature whether or
 * not the shell was told to wrap it.
 *
 * @param command - the command as the harness reports it.
 */
export function unwrapCommand(command: string): string {
  if (command.startsWith(LEGACY_PREFIX))
    return command.slice(LEGACY_PREFIX.length);
  if (!command.startsWith(REWRITE_PREFIX)) return command;
  const body = command.slice(REWRITE_PREFIX.length);
  const at = body.lastIndexOf(EPILOGUE_MARK);
  return at === -1 ? body : body.slice(0, at);
}

/**
 * The first failure a wrapped command recorded, read back and removed. Undefined
 * when there is none, or the file is missing or unreadable.
 *
 * @param toolUseId - the id of the tool call the file was written for.
 */
export function readStatus(toolUseId: string): number | undefined {
  const path = statusPathFor(toolUseId);
  if (path === undefined) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // The next read will see it again; nothing else depends on it.
  }
  const code = Number(text.trim());
  return Number.isInteger(code) && code > 0 && code < 256 ? code : undefined;
}

/**
 * The stdout for a PreToolUse hook call: the rewritten Bash input, or nothing
 * when the call is left as it is. Never throws; a payload it cannot read gets
 * nothing, so the command runs unchanged.
 *
 * @param text - the JSON Claude Code wrote on stdin.
 * @param env - the environment, passed to rewriteCommand().
 */
export function pipefailResponse(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "";
  }
  if (typeof value !== "object" || value === null) return "";
  const event = value as {
    hook_event_name?: unknown;
    tool_name?: unknown;
    tool_input?: unknown;
    tool_use_id?: unknown;
  };
  if (event.hook_event_name !== "PreToolUse" || event.tool_name !== "Bash")
    return "";
  const input = event.tool_input;
  if (typeof input !== "object" || input === null) return "";
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return "";
  const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
  const rewritten = rewriteCommand(command, statusPathFor(id), env);
  if (rewritten === undefined) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input, command: rewritten },
    },
  });
}
