// The PreToolUse rewrite for piped Bash commands (#131).
//
// A pipeline's exit status is its last command's, so `npm test 2>&1 | tail -15`
// reaches the hooks as a success whatever `npm test` did, and Claude Code
// reports no exit code for a Bash result (src/claude-code.ts). With
// `set -o pipefail` in front, the shell's status is the first failing stage's,
// and Claude Code's own failure path reports it as `Exit code N`, which
// toCapture() already reads. So the hook adds that prefix to a piped command
// and leaves every other command alone.
//
// This changes what the agent runs: a pipeline now fails when any stage fails,
// so `grep pattern file | head` with no match reports a failure. Set
// ANTIBODY_PIPEFAIL=0 to turn the rewrite off.
//
// The prefix is as far as a rewrite can go, measured against the client itself
// (Claude Code 2.1.282, scripts/step0): it runs a Bash call as
//
//   source <snapshot> && … && eval '<command>' < /dev/null && pwd -P >| <file>
//
// so the command is eval'ed inside a `&&` list. Bash runs no ERR trap and
// honours no errexit for a command in such a list, and a subshell inside one
// inherits that: only `set -o pipefail` still reaches the shell (the live
// payloads in tests/pipefail.test.ts pin both halves). Wrapping the command to
// read a failure out of it therefore reports nothing, which is why the rewrite
// stops here and a pipeline that is not the last command of a `;` chain stays
// unrecorded - the gap #131 keeps open.
/** The environment variable that turns the rewrite off when set to 0. */
export const PIPEFAIL_ENV = "ANTIBODY_PIPEFAIL";

/**
 * The prefix the rewrite puts in front of a piped command. The `2>/dev/null`
 * leaves a shell without pipefail (dash, `sh`) running the command unchanged
 * rather than printing an error over the agent's own output.
 */
export const PIPEFAIL_PREFIX = "set -o pipefail 2>/dev/null; ";

/** The harness name the PreToolUse hook is registered under. */
export const PRE_TOOL_HARNESS = "claude-code-pretool";

// A pipe between two stages, and not a shell `||`: `a | b` is a pipeline,
// `a || b` is not, and neither is a `2>&1` redirection.
const PIPELINE = /(^|[^|])\|([^|]|$)/;

// What an earlier version of the rewrite wrote. Still taken off a payload, so a
// command captured across that upgrade keeps the signature it had.
const EARLIER_PREFIX = "set -o pipefail; ";

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
 * The command with the pipefail prefix, or undefined when it needs none: not
 * a pipeline, already set, or the rewrite is switched off.
 *
 * @param command - the Bash command the agent wrote.
 * @param env - the environment; ANTIBODY_PIPEFAIL=0 switches the rewrite off.
 */
export function pipefailCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env[PIPEFAIL_ENV] === "0") return undefined;
  if (!hasPipeline(command)) return undefined;
  if (/\bpipefail\b/.test(command)) return undefined;
  return `${PIPEFAIL_PREFIX}${command}`;
}

/**
 * The command the agent wrote, from the command a PostToolUse payload carries:
 * a prefix the rewrite added is taken off again, so one command keeps one
 * signature whether or not the shell was told to run it piped.
 *
 * @param command - the command as the harness reports it.
 */
export function unwrapCommand(command: string): string {
  for (const prefix of [PIPEFAIL_PREFIX, EARLIER_PREFIX])
    if (command.startsWith(prefix)) return command.slice(prefix.length);
  return command;
}

/**
 * The stdout for a PreToolUse hook call: the rewritten Bash input, or nothing
 * when the call is left as it is. Never throws; a payload it cannot read gets
 * nothing, so the command runs unchanged.
 *
 * @param text - the JSON Claude Code wrote on stdin.
 * @param env - the environment, passed to pipefailCommand().
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
  const rewritten = pipefailCommand(command, env);
  if (rewritten === undefined) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input, command: rewritten },
    },
  });
}
