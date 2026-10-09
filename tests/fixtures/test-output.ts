// Real test-runner output, captured on Node 24 by running the benchmark's own
// fixture with its traps unmet, and a one-test project that passes:
//
//   cd bench/fixture && node --test --test-reporter=tap
//   node --test                                  # the spec reporter, the default
//   cd <one passing test> && node --test --test-reporter=tap
//   node --test
//
// This is the text a Bash result hands a hook, which src/failure-hints.ts has
// to read (#131). Both reporters put their verdict in a block of lines, so the
// failing runs below do not end on the line that says they failed.

/** TAP, seven failing files: the summary's `# fail 7` sits above the last line. */
export const TAP_FAILED = [
  "  exitCode: 1",
  "  signal: ~",
  "  error: 'test failed'",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "1..7",
  "# tests 7",
  "# suites 0",
  "# pass 0",
  "# fail 7",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 255.2242",
].join("\n");

/** TAP, one passing test: `# fail 0`, and the same `# duration_ms` ending. */
export const TAP_PASSED = [
  "  duration_ms: 0.3914",
  "  type: 'test'",
  "  ...",
  "1..1",
  "# tests 1",
  "# suites 0",
  "# pass 1",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 86.0615",
].join("\n");

/** The spec reporter with seven failing files: `ℹ fail 7`, then the `✖` list. */
export const SPEC_FAILED = [
  "ℹ tests 7",
  "ℹ suites 0",
  "ℹ pass 0",
  "ℹ fail 7",
  "ℹ cancelled 0",
  "ℹ skipped 0",
  "ℹ todo 0",
  "ℹ duration_ms 272.455",
  "✖ failing tests:",
  "✖ test\\cart.test.js (212.0791ms)",
  "✖ test\\dates.test.js (184.7577ms)",
  "✖ test\\list.test.js (164.3194ms)",
  "✖ test\\money.test.js (143.7797ms)",
  "✖ test\\server.test.js (107.0088ms)",
  "✖ test\\text.test.js (86.7688ms)",
  "✖ test\\validate.test.js (90.035ms)",
].join("\n");

/** The spec reporter with everything passing: `ℹ fail 0`, and no `✖` at all. */
export const SPEC_PASSED = [
  "✔ adds (0.3832ms)",
  "ℹ tests 1",
  "ℹ suites 0",
  "ℹ pass 1",
  "ℹ fail 0",
  "ℹ cancelled 0",
  "ℹ skipped 0",
  "ℹ todo 0",
  "ℹ duration_ms 83.116",
].join("\n");
