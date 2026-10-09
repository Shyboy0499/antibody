import { describe, expect, it } from "vitest";
import {
  PIPEFAIL_PREFIX,
  pipefailCommand,
  pipefailResponse,
} from "../src/pipefail";

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
