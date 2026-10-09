// The one "this output reads like a failure" rule, shared by the harness
// adapters that cannot read an exit code.
//
// Codex CLI never reports one, and neither does Claude Code for a pipeline
// whose last command succeeded: `npm test 2>&1 | tail -15` exits 0, so the
// result text is the only evidence a failure happened (#131). One module,
// because three copies of the rule would let the same command be a failure in
// one harness and a success in another - the divergence the fingerprints exist
// to prevent.
//
// Only the last non-empty line is read: a successful command rarely ends on
// one, and a failed one usually does. Commands that only print files or text
// are never failures, whatever their output says. The rule stays a last
// resort: a code a harness reports, or Claude Code's own `Exit code N`, is
// always read first (src/hook-input.ts).

/** The exit code an inferred shell failure is recorded with. */
export const INFERRED_EXIT_CODE = 1;

// Lines that end a failed command's output.
const FAILURE_LINES = [
  /^(?:error|fatal)(?:\[[\w-]+\])?:/i, // error: …, fatal: …, error[E0308]: …
  /^(?:[A-Z]\w*)?(?:Error|Exception)(?::|$)/, // TypeError: …, Error: …
  /^Environment variable not found:/, // the trap's bare form, without Error:
  /\bcommand not found\b/,
  /\bEADDRINUSE\b/,
  /\bCannot find module\b/,
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
