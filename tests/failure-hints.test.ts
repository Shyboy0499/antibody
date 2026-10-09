import { describe, expect, it } from "vitest";
import {
  INFERRED_EXIT_CODE,
  benignExit,
  looksFailed,
} from "../src/failure-hints";
import {
  SPEC_FAILED,
  SPEC_PASSED,
  TAP_FAILED,
  TAP_PASSED,
  VITEST_FAILED,
  VITEST_PASSED,
} from "./fixtures/test-output";

describe("failure-hints", () => {
  it("records an inferred failure with exit code 1", () => {
    expect(INFERRED_EXIT_CODE).toBe(1);
  });

  it.each([
    // #131: a pipeline's exit status is its last command's, so only the
    // output says anything about the command the agent meant to run.
    ["npm test 2>&1 | tail -15", "npm ERR! code ELIFECYCLE"],
    [
      'npm test 2>&1 | grep -B3 -A25 "not ok"',
      "      Tests  1 failed | 9 passed (10)",
    ],
    ["pnpm dev", "EADDRINUSE: address already in use :::3000"],
    ["node app.js", "Cannot find module 'express'"],
    ["pnpm test", "Environment variable not found: DATABASE_URL."],
    ['node -e "process.exit(3)"', "error: script failed"],
    ["node --test", "# fail 1"],
    ["node --test 2>&1 | tail -15", "not ok 3 - adds two numbers"],
    // Only one segment of a chain has to do real work for the chain to fail.
    ["tail -15 build.log && node --test", "# fail 1"],
    ["cat errors.log; node app.js", "Cannot find module 'express'"],
  ])("%s ending in %j reads as a failure", (command, output) => {
    expect(looksFailed(command, output)).toBe(true);
  });

  it.each([
    ["cat package.json | grep -i error", `"error": "Cannot find module x"`],
    ["git log -1", "fatal: bad revision"],
    ["tail -15 build.log", "error: could not compile"],
    ["npm test 2>&1 | tail -15", "Tests  636 passed (636)"],
    ["npm test 2>&1 | tail -15", ""],
    ["node --test", "# fail 0"],
    [undefined, "12 passed"],
    // Every segment displays, so the output is what was asked for.
    ["cat package.json | grep -i error && echo done", "Cannot find module x"],
    ["git log -1 --stat | head -20", "fatal: bad revision"],
    // A redirection's `&` is not a separator.
    [
      "cat package.json 2>&1 | grep -i error",
      `"error": "Cannot find module x"`,
    ],
  ])("%s ending in %j reads as a success", (command, output) => {
    expect(looksFailed(command, output)).toBe(false);
  });

  describe("a piped test run", () => {
    it("reads a TAP summary that the last line only follows", () => {
      expect(looksFailed("npm test 2>&1 | tail -15", TAP_FAILED)).toBe(true);
      expect(looksFailed("npm test 2>&1 | tail -15", TAP_PASSED)).toBe(false);
    });

    it("reads the spec reporter's summary and its list of files", () => {
      expect(looksFailed("npm test 2>&1 | tail -15", SPEC_FAILED)).toBe(true);
      expect(looksFailed("npm test 2>&1 | tail -15", SPEC_PASSED)).toBe(false);
    });

    it("reads vitest's summary, which sits above its Duration line", () => {
      expect(looksFailed("npm test 2>&1 | tail -15", VITEST_FAILED)).toBe(true);
      expect(looksFailed("npm test 2>&1 | tail -15", VITEST_PASSED)).toBe(
        false,
      );
    });

    it("reads a chain whose first segment only appends to a file", () => {
      const heredoc = [
        "cat >> notes.md <<'EOF'",
        "trap log",
        "EOF",
        "&& npm test 2>&1 | tail -15",
      ].join("\n");
      expect(looksFailed(heredoc, TAP_FAILED)).toBe(true);
    });
  });

  describe("an exit of 1 that is a meaning", () => {
    it.each([
      ["grep -rn TODO src"],
      ['npm test 2>&1 | grep -B3 -A25 "not ok"'],
      ["git diff --exit-code"],
      ["git grep -n TODO"],
      ["rg TODO src"],
      ["find src -name '*.ts'"],
      ["test -f package.json"],
      ["[ -d src ]"],
    ])("%s is not a failure", (command) => {
      expect(benignExit(command)).toBe(true);
    });

    it.each([
      ["npm test"],
      ["git push"],
      ["node app.js"],
      ["grep -rn TODO src | npm test"],
      [undefined],
    ])("%s is judged by its code", (command) => {
      expect(benignExit(command)).toBe(false);
    });
  });
});
