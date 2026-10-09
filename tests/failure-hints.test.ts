import { describe, expect, it } from "vitest";
import { INFERRED_EXIT_CODE, looksFailed } from "../src/failure-hints";

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
    // node --test, which the benchmark's fixture runs: the TAP summary is the
    // last line of a failing run, and `# fail 0` is how a passing one ends.
    ["node --test", "# fail 1"],
    ["node --test 2>&1 | tail -15", "not ok 3 - adds two numbers"],
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
  ])("%s ending in %j reads as a success", (command, output) => {
    expect(looksFailed(command, output)).toBe(false);
  });
});
