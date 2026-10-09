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
// A failed command's output is read twice, because a failure does not always
// end on its own line: the last non-empty line, and the test-runner markers
// below, which come as a block. Commands that only print files or text are
// never failures, whatever their output says. The rule stays a last resort: a
// code a harness reports, or Claude Code's own `Exit code N`, is always read
// first (src/hook-input.ts).

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

// A test runner's verdict is a block of lines, not one line: a failing
// `node --test` run ends its TAP output with `# fail 7` and then
// `# duration_ms …`, and its spec reporter with `ℹ fail 7` and a list of `✖`
// files. Reading only the last line misses both, so the runner's own markers
// are read wherever they appear in the output. `# fail 0` and `ℹ fail 0` are
// how a passing run ends, and match nothing here.
const RUNNER_FAILURE = /^(?:# fail [1-9]\d*|not ok\b|ℹ fail [1-9]\d*|✖ )/m;

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

// Exits that are a meaning rather than a failure, by the table Claude Code
// itself classifies a Bash result with (read off the 2.1.282 bundle): for
// these, an exit of 1 says what happened - `grep` and friends report "no
// matches", `diff` "files differ", `test` "condition is false" - and only 2 or
// more is an error.
const BENIGN_EXITS = new Set([
  "grep",
  "rg",
  "egrep",
  "fgrep",
  "find",
  "diff",
  "test",
  "[",
]);
const BENIGN_GIT = new Set(["diff", "grep"]);

// A command line as the segments it chains: `a && b`, `a | b`, `a; b`, `a && b`.
// An `&` that belongs to a redirection (`2>&1`) is not a separator.
const CHAIN = /\s*(?:&&|\|\||;|\||&(?!\d))\s*/;

/** A command line as its non-empty segments, in order. */
function segmentsOf(command: string | undefined): string[] {
  return (command ?? "")
    .split(CHAIN)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** Whether one segment of a command line only shows files or text. */
function displayOnly(segment: string): boolean {
  const words = segment.trim().split(/\s+/);
  const first = words[0] ?? "";
  if (DISPLAY_COMMANDS.has(first)) return true;
  return first === "git" && DISPLAY_GIT.has(words[1] ?? "");
}

/**
 * Whether an exit of 1 is a meaning rather than a failure for a command.
 *
 * Claude Code reads the last segment of the pipeline for this - `npm test |
 * grep -c ok` is a `grep`, and its 1 means "no matches", not a failed test -
 * so a code it reports is only read as a failure when the last segment does
 * not give it a meaning. Nothing is inferred from this: a pipeline that
 * reports no code at all is still judged by its output.
 *
 * @param command - the command line, when known.
 */
export function benignExit(command: string | undefined): boolean {
  const words = (segmentsOf(command).at(-1) ?? "").split(/\s+/);
  const first = words[0] ?? "";
  if (first === "git") return BENIGN_GIT.has(words[1] ?? "");
  return BENIGN_EXITS.has(first);
}

/**
 * Whether a shell command's output reads like a failure, for a harness that
 * does not report the exit code: it carries a test runner's verdict, or its
 * last non-empty line names an error, and the command is not one that only
 * displays text.
 *
 * Every segment of a chained command has to display text for that exemption,
 * since what the chain does is only as harmless as its parts: `tail -5
 * build.log && node --test` can fail, `cat build.log | grep -i error` cannot.
 *
 * @param command - the command line, when known.
 * @param output - everything the command printed.
 */
export function looksFailed(
  command: string | undefined,
  output: string,
): boolean {
  const segments = segmentsOf(command);
  if (segments.length > 0 && segments.every(displayOnly)) return false;
  if (RUNNER_FAILURE.test(output)) return true;
  const last = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  return last !== undefined && FAILURE_LINES.some((re) => re.test(last));
}
