// The PreToolUse rewrite, for Bash commands whose own status is not the whole
// story (#131).
//
// A shell reports the last command's status: for a pipeline (`npm test 2>&1 |
// tail -15`) and for a `;` chain (`npm test; echo done`) alike. So a failure
// anywhere else in the command line reaches the hooks as a success, and Claude
// Code reports no exit code for a Bash result at all (src/claude-code.ts). The
// hook therefore wraps such a command, so the shell itself reports the truth:
//
//   set -o pipefail 2>/dev/null; __antibody_failed=0
//   trap '__antibody_failed=$?' ERR 2>/dev/null
//   <the command, verbatim>
//   __antibody_last=$?; if [ "$__antibody_failed" -ne 0 ]; then exit
//   "$__antibody_failed"; fi; exit "$__antibody_last"
//
// `set -o pipefail` makes a pipeline's status its first failing stage's, and
// the ERR trap fires for a command that failed outside a tested context - the
// left of `&&` or `||`, the condition of `if`/`while`/`until`, and `! cmd` are
// all exempt - so a failure the agent handled is not recorded, and the trap's
// own `$?` keeps the failing command's code. The epilogue exits with it, which
// Claude Code's failure path reports as `Exit code N`, which toCapture() already
// reads.
//
// This changes what the agent runs: a call now fails when any command in it
// failed without being handled, so a bare `grep -q pattern file` before a
// passing command is a failure, and `cmd | head` can report 141 when `head`
// closes early. Set ANTIBODY_PIPEFAIL=0 to turn the rewrite off.

/** The environment variable that turns the rewrite off when set to 0. */
export const PIPEFAIL_ENV = "ANTIBODY_PIPEFAIL";

/**
 * What the rewrite puts in front of a command. The trailing space keeps the
 * command's own first line readable, and the `2>/dev/null` on both builtins
 * leaves a shell that has neither pipefail nor an ERR trap running the command
 * unchanged rather than printing about it.
 */
export const REWRITE_PREFIX =
  "set -o pipefail 2>/dev/null; __antibody_failed=0; trap '__antibody_failed=$?' ERR 2>/dev/null; ";

/**
 * What the rewrite puts after it, on a line of its own: a line of its own
 * because a command may end in a heredoc, whose terminator the epilogue would
 * otherwise swallow.
 */
export const REWRITE_SUFFIX =
  '__antibody_last=$?; if [ "$__antibody_failed" -ne 0 ]; then exit "$__antibody_failed"; fi; exit "$__antibody_last"';

// The names the rewrite uses. A command that already carries one is left alone:
// the rewrite is then idempotent, and unwrapCommand() has nothing to guess.
const MARKER = "__antibody_";

/** The harness name the PreToolUse hook is registered under. */
export const PRE_TOOL_HARNESS = "claude-code-pretool";

// A pipe between two stages, and not a shell `||`: `a | b` is a pipeline,
// `a || b` is not, and neither is a `2>&1` redirection.
const PIPELINE = /(^|[^|])\|([^|]|$)/;

// More than one command at the top level: `;`, a newline, a pipe (or `||`), or
// an `&` that is not a redirection's `2>&1`. The reading is textual - a `;`
// inside quotes counts - and wrapping a command that turns out to be one
// command anyway costs nothing, because the epilogue then exits its status.
const COMPOUND = /[;\n|]|&(?!\d)/;

/**
 * Whether a command line holds a pipeline, as the rewrite tells one.
 *
 * A pipeline's status is its last command's, which is the whole of #131: the
 * rewrite exists so a shell reports the failing stage's status, and an adapter
 * reads the output when its harness reports the last stage's zero instead
 * (src/gemini.ts).
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

/**
 * The command as the shell must run it: wrapped, so a failure anywhere in it
 * reaches Claude Code as an `Exit code N`. Undefined when it needs none: one
 * command, already wrapped, or the rewrite is switched off.
 *
 * @param command - the Bash command the agent wrote.
 * @param env - the environment; ANTIBODY_PIPEFAIL=0 switches the rewrite off.
 */
export function rewriteCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env[PIPEFAIL_ENV] === "0") return undefined;
  if (!needsRewrite(command)) return undefined;
  if (command.includes(MARKER)) return undefined;
  return `${REWRITE_PREFIX}${command}\n${REWRITE_SUFFIX}`;
}

/**
 * The command the agent wrote, from the command a PostToolUse payload carries:
 * the rewrite's prefix and epilogue taken off again, so one command keeps one
 * signature whether or not the shell was told to wrap it.
 *
 * @param command - the command as the harness reports it.
 */
export function unwrapCommand(command: string): string {
  if (!command.startsWith(REWRITE_PREFIX)) return command;
  const body = command.slice(REWRITE_PREFIX.length);
  const epilogue = `\n${REWRITE_SUFFIX}`;
  return body.endsWith(epilogue)
    ? body.slice(0, body.length - epilogue.length)
    : body;
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
  };
  if (event.hook_event_name !== "PreToolUse" || event.tool_name !== "Bash")
    return "";
  const input = event.tool_input;
  if (typeof input !== "object" || input === null) return "";
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return "";
  const rewritten = rewriteCommand(command, env);
  if (rewritten === undefined) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input, command: rewritten },
    },
  });
}
