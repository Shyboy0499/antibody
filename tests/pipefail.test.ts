import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { benignExit } from "../src/failure-hints";
import {
  PIPEFAIL_PREFIX,
  pipefailCommand,
  pipefailResponse,
} from "../src/pipefail";

// A shell to test the rewrite against. A machine without a usable one (Windows,
// where `bash` on PATH may be a WSL without a distribution) skips the tests that
// run a command for real; the string tests above them still run everywhere.
const shellWorks = spawnSync("bash", ["-c", "exit 0"]).status === 0;
const shell = (script: string) =>
  spawnSync("bash", ["-c", script], { encoding: "utf8" });

/**
 * One Bash call as Claude Code 2.1.282 really runs it, read off the client
 * itself (scripts/step0): the command is eval'ed inside a `&&` list, and a
 * command follows the eval. What the rewrite can do depends on this shape.
 */
const asClient = (command: string) =>
  `true && eval '${command.replaceAll("'", "'\\''")}' < /dev/null && pwd -P > /dev/null`;

const payload = (command: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "probe" },
    ...extra,
  });

describe("pipefailCommand", () => {
  it.each([
    ["npm test 2>&1 | tail -15", `${PIPEFAIL_PREFIX}npm test 2>&1 | tail -15`],
    [
      'node -e "process.exit(3)" | tail -5',
      `${PIPEFAIL_PREFIX}node -e "process.exit(3)" | tail -5`,
    ],
    ["a | b | c", `${PIPEFAIL_PREFIX}a | b | c`],
  ])("prefixes the pipeline %s", (command, want) => {
    expect(pipefailCommand(command, {})).toBe(want);
  });

  it.each([
    ["npm test", "no pipe"],
    ["npm test 2>&1", "a redirection is not a pipe"],
    ["a || b", "|| is a shell or, not a pipe"],
    ["set -o pipefail; npm test | tail", "already set"],
    ["npm test | tail -5", "switched off"],
  ])("leaves %s alone (%s)", (command, reason) => {
    const env = reason === "switched off" ? { ANTIBODY_PIPEFAIL: "0" } : {};
    expect(pipefailCommand(command, env)).toBeUndefined();
  });
});

describe("pipefailResponse", () => {
  it("answers a piped Bash command with the rewritten input", () => {
    const out = JSON.parse(
      pipefailResponse(payload("npm test 2>&1 | tail -15", { cwd: "/r" }), {}),
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: `${PIPEFAIL_PREFIX}npm test 2>&1 | tail -15`,
          description: "probe",
        },
      },
    });
  });

  it("says nothing for other tools, other events and unreadable payloads", () => {
    expect(pipefailResponse(payload("ls | wc"), {})).not.toBe("");
    expect(
      pipefailResponse(payload("ls | wc").replace('"Bash"', '"Read"'), {}),
    ).toBe("");
    expect(
      pipefailResponse(
        payload("ls | wc").replace("PreToolUse", "PostToolUse"),
        {},
      ),
    ).toBe("");
    expect(pipefailResponse("{", {})).toBe("");
    expect(pipefailResponse("null", {})).toBe("");
    expect(
      pipefailResponse(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: "x",
        }),
        {},
      ),
    ).toBe("");
    expect(
      pipefailResponse(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 3 },
        }),
        {},
      ),
    ).toBe("");
  });

  it("says nothing for a plain command", () => {
    expect(pipefailResponse(payload("npm test"), {})).toBe("");
  });
});

describe("the prefix on a recorded command", () => {
  it("is taken off the command a PostToolUse payload carries", async () => {
    const { parseHookInput } = await import("../src/claude-code");
    const input = parseHookInput(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "s",
        cwd: "/r",
        tool_name: "Bash",
        tool_input: { command: `${PIPEFAIL_PREFIX}npm test | tail -5` },
        tool_response: { stdout: "" },
      }),
    );
    expect(input?.command).toBe("npm test | tail -5");
  });
});

// #131's review asked what the rewrite does to commands whose exit 1 is a
// meaning rather than a failure (`grep`, `diff`, `test`): it leaves them as the
// agent wrote them, so Claude Code's own table - and antibody's mirror of it
// (benignExit, src/failure-hints.ts) - reads the command itself, not a rewrite.
describe("benign commands", () => {
  it.each([
    ["grep -q pattern file; echo done", "a chain a passing command ends"],
    ["diff a b; echo done", "the same, for diff"],
    ["test -f x; echo done", "the same, for test"],
    ["grep -q pattern file", "a bare grep"],
    ["git diff --stat", "git's own benign pair"],
  ])("leaves %s alone (%s)", (command) => {
    expect(pipefailCommand(command, {})).toBeUndefined();
  });

  it("prefixes a pipeline whose last stage is benign, and keeps that stage readable", () => {
    // The prefix goes in front; the last segment is still the `grep` Claude
    // Code's table reads, so a 1 stays "no matches" for both readers.
    expect(pipefailCommand("npm test 2>&1 | grep -q FAIL", {})).toBe(
      `${PIPEFAIL_PREFIX}npm test 2>&1 | grep -q FAIL`,
    );
    expect(benignExit("npm test 2>&1 | grep -q FAIL")).toBe(true);
  });
});

// The live check #131's thread asked for (a real Claude Code 2.1.282 session
// against scripts/step0's mock endpoint, 2026-10-10): inside the client's own
// invocation the prefix still works, and `errexit` is suppressed, so a wrapper
// around the command reports nothing there. The ERR trap is worse than
// suppressed: it does not run in the shell the client uses on Windows (Git
// Bash 5.3.9, the live session) and does run in Ubuntu's bash 5.2 (CI), so a
// fleet's rewrite would behave differently per machine. Both are why the
// rewrite is a prefix and not a wrapper; the ERR half is not asserted here
// because it is not the same shell everywhere.
describe("the client's own shell context", () => {
  it.skipIf(!shellWorks)(
    "keeps pipefail, so a rewritten pipeline still reports the failing stage",
    () => {
      const rewritten = pipefailCommand("false | tail -1", {}) as string;
      expect(shell(asClient(rewritten)).status).toBe(1);
    },
  );

  it.skipIf(!shellWorks)(
    "honours no errexit for a command in it, not even in a subshell",
    () => {
      expect(
        shell(asClient("set -e; cat missing.txt; echo after")).stdout,
      ).toContain("after");
      expect(
        shell(asClient("( set -e; cat missing.txt; echo after )")).stdout,
      ).toContain("after");
      // Outside it, errexit stops the command as it would for a plain script.
      expect(shell("set -e; cat missing.txt; echo after").stdout).not.toContain(
        "after",
      );
    },
  );
});
