import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  PIPEFAIL_ENV,
  REWRITE_PREFIX,
  REWRITE_SUFFIX,
  needsRewrite,
  pipefailResponse,
  rewriteCommand,
  unwrapCommand,
} from "../src/pipefail";

// A shell to test the wrapper against: the rewrite is for a POSIX shell, and
// `bash` is the one Claude Code's Bash tool runs. A machine without a usable
// one (Windows, where `bash` on PATH may be a WSL without a distribution)
// skips the two tests that run a command for real; the string tests above them
// still run everywhere.
const shellWorks = spawnSync("bash", ["-c", "exit 0"]).status === 0;
const bash = (command: string) =>
  spawnSync("bash", ["-c", command], { encoding: "utf8" });

const payload = (command: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "probe" },
    ...extra,
  });

describe("needsRewrite", () => {
  it.each([
    ["npm test 2>&1 | tail -15", "a pipeline"],
    ["npm test; echo done", "a ; chain"],
    ["a && b", "an && chain"],
    ["a || b", "an || chain"],
    ["npm test &", "a background command"],
    ["npm test\n echo done", "a second line"],
  ])("wraps %s (%s)", (command) => {
    expect(needsRewrite(command)).toBe(true);
  });

  it.each([
    ["npm test", "one command"],
    ["npm test 2>&1", "a redirection's & is not a separator"],
    ["pnpm test -- --reporter=dot", "one command with flags"],
  ])("leaves %s alone (%s)", (command) => {
    expect(needsRewrite(command)).toBe(false);
  });
});

describe("rewriteCommand", () => {
  it("wraps a chain, and a pipeline, so the shell reports the whole of it", () => {
    for (const command of ["npm test; echo done", "npm test 2>&1 | tail -15"]) {
      expect(rewriteCommand(command, {})).toBe(
        `${REWRITE_PREFIX}${command}\n${REWRITE_SUFFIX}`,
      );
    }
  });

  it.each([
    ["npm test", "one command's status is its own"],
    ["npm test 2>&1", "a redirection is not a second command"],
  ])("leaves %s alone (%s)", (command) => {
    expect(rewriteCommand(command, {})).toBeUndefined();
  });

  it("is idempotent: a command that already carries the wrapper is left alone", () => {
    const once = rewriteCommand("false; echo done", {}) as string;
    expect(rewriteCommand(once, {})).toBeUndefined();
  });

  it("is switched off by ANTIBODY_PIPEFAIL=0", () => {
    expect(rewriteCommand("a; b", { [PIPEFAIL_ENV]: "0" })).toBeUndefined();
    expect(rewriteCommand("a | b", { [PIPEFAIL_ENV]: "0" })).toBeUndefined();
  });
});

describe("unwrapCommand", () => {
  it.each([
    "npm test; echo done",
    "npm test 2>&1 | tail -15",
    "cat >> notes.md <<'EOF'\ntrap log\nEOF\nfalse; echo done",
    "false; echo done # a trailing comment",
  ])("gives back the command the agent wrote: %j", (command) => {
    const wrapped = rewriteCommand(command, {}) as string;
    expect(unwrapCommand(wrapped)).toBe(command);
  });

  it("leaves a command the rewrite never touched as it is", () => {
    expect(unwrapCommand("npm test")).toBe("npm test");
  });
});

describe("pipefailResponse", () => {
  it("answers a chain with the wrapped input, other fields kept", () => {
    const out = JSON.parse(
      pipefailResponse(payload("npm test; echo done", { cwd: "/r" }), {}),
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: `${REWRITE_PREFIX}npm test; echo done\n${REWRITE_SUFFIX}`,
          description: "probe",
        },
      },
    });
  });

  it("says nothing for other tools, other events and unreadable payloads", () => {
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

  it("says nothing for one command", () => {
    expect(pipefailResponse(payload("npm test"), {})).toBe("");
  });
});

describe("the wrapper in a real shell", () => {
  it.skipIf(!shellWorks)(
    "makes a failure that is not the last command the shell's status",
    () => {
      const command = "echo one; false; echo three";
      const plain = bash(command);
      const wrapped = bash(rewriteCommand(command, {}) as string);
      // What the hooks see today: the last command's 0.
      expect(plain.status).toBe(0);
      // What they see wrapped, with the output the agent would have read.
      expect(wrapped.status).toBe(1);
      expect(wrapped.stdout).toBe(plain.stdout);
      expect(wrapped.stderr).toBe("");
    },
  );

  it.skipIf(!shellWorks)(
    "leaves a failure the agent handled, and the agent's own $?, alone",
    () => {
      const handled = bash(
        rewriteCommand("false || echo handled", {}) as string,
      );
      expect(handled.status).toBe(0);
      expect(handled.stdout).toBe("handled\n");
      const reads = bash(rewriteCommand('false; echo "rc=$?"', {}) as string);
      expect(reads.status).toBe(1);
      expect(reads.stdout).toBe("rc=1\n");
    },
  );
});
