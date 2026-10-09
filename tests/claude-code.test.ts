import { describe, expect, it } from "vitest";
import { TransientCounter, classify } from "../src/capture";
import {
  ADDITIONAL_CONTEXT_MAX_CHARS,
  CLAUDE_CODE,
  hookResponse,
  parseHookInput,
} from "../src/claude-code";
import { HOOK_EVENTS, toCapture, toToolCall } from "../src/hook-input";
import type { HookInput } from "../src/hook-input";
import { callOutcome } from "../src/resolve-detect";
import { TAP_FAILED } from "./fixtures/test-output";

const common = {
  session_id: "s-1",
  cwd: "/work/agent-a",
  transcript_path: "/t.jsonl",
};
const payload = (fields: Record<string, unknown>) =>
  JSON.stringify({ ...common, ...fields });

const bashFailure = parseHookInput(
  payload({
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "pnpm test", description: "Run tests" },
    tool_use_id: "toolu_1",
    error: "Exit code 1\nError: Environment variable not found: DATABASE_URL.",
  }),
) as HookInput;

describe("parseHookInput", () => {
  it("names the harness and the events it handles", () => {
    expect(CLAUDE_CODE).toBe("claude-code");
    expect(HOOK_EVENTS).toContain("PostToolUseFailure");
  });

  it("reads a PostToolUseFailure", () => {
    expect(bashFailure).toEqual({
      event: "PostToolUseFailure",
      sessionId: "s-1",
      cwd: "/work/agent-a",
      transcriptPath: "/t.jsonl",
      toolName: "Bash",
      command: "pnpm test",
      error:
        "Exit code 1\nError: Environment variable not found: DATABASE_URL.",
    });
  });

  it("keeps the transcript path, and leaves out a blank or missing one", () => {
    const start = (fields: Record<string, unknown>) =>
      parseHookInput(
        JSON.stringify({
          session_id: "s-1",
          cwd: "/w",
          hook_event_name: "SessionStart",
          ...fields,
        }),
      );
    expect(start({ transcript_path: "/t.jsonl" })?.transcriptPath).toBe(
      "/t.jsonl",
    );
    for (const transcript_path of [undefined, "", "  ", null, 7])
      expect(start({ transcript_path })).not.toHaveProperty("transcriptPath");
  });

  it("reads tool_output as text, and an older tool_response object", () => {
    const text = parseHookInput(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_output: "ok",
      }),
    );
    expect(text?.output).toBe("ok");
    const streams = parseHookInput(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: {
          stdout: "a\nb",
          stderr: "warn",
          interrupted: false,
          exit_code: 0,
        },
      }),
    );
    expect(streams).toMatchObject({
      output: "a\nb\nwarn",
      exitCode: 0,
      command: "ls",
    });
    const other = parseHookInput(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_response: { ok: true },
      }),
    );
    expect(other?.output).toBe('{"ok":true}');
  });

  it("keeps the subagent id and ignores a blank command", () => {
    const input = parseHookInput(
      payload({
        hook_event_name: "PostToolUse",
        agent_id: "sub-7",
        tool_name: "Bash",
        tool_input: { command: "   " },
      }),
    );
    expect(input?.agentId).toBe("sub-7");
    expect(input?.command).toBeUndefined();
    expect(input?.output).toBeUndefined();
  });

  it.each([
    ["text that is not JSON", "{"],
    ["JSON that is not an object", "[1]"],
    [
      "an event antibody does not handle",
      payload({ hook_event_name: "Notification" }),
    ],
    [
      "a missing session",
      JSON.stringify({ hook_event_name: "SessionStart", cwd: "/w" }),
    ],
    [
      "a blank session",
      payload({ hook_event_name: "SessionStart", session_id: "" }),
    ],
    [
      "a missing cwd",
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" }),
    ],
  ])("reads %s as nothing", (_name, text) => {
    expect(parseHookInput(text)).toBeUndefined();
  });
});

describe("toCapture", () => {
  it("turns Claude Code's exit-code wording into a command capture", () => {
    expect(toCapture(bashFailure)).toEqual({
      kind: "command",
      toolName: "Bash",
      command: "pnpm test",
      text: "Error: Environment variable not found: DATABASE_URL.\n[exit code: 1]",
    });
  });

  it("feeds the ported classifier a command-exit record, led by the command", () => {
    const classified = classify(
      toCapture(bashFailure)!,
      new TransientCounter(),
    );
    expect(classified?.decision).toBe("record");
    expect(classified?.record).toMatchObject({
      category: "command-exit",
      exitCode: 1,
      message:
        "pnpm test → Error: Environment variable not found: DATABASE_URL.",
    });
  });

  it("turns any other failure into a tool capture", () => {
    const input = parseHookInput(
      payload({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Read",
        tool_input: { file_path: "a.ts" },
        error: "File does not exist.",
      }),
    )!;
    expect(toCapture(input)).toEqual({
      kind: "tool",
      toolName: "Read",
      isError: true,
      message: "File does not exist.",
    });
  });

  it("captures a PostToolUse whose result reports a non-zero exit code", () => {
    const input = parseHookInput(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_response: { stdout: "", stderr: "boom", exitCode: 2 },
      }),
    )!;
    expect(toCapture(input)).toEqual({
      kind: "command",
      toolName: "Bash",
      text: "boom\n[exit code: 2]",
    });
  });

  it("captures nothing for a success or a non-tool event", () => {
    const ok = parseHookInput(
      payload({ hook_event_name: "PostToolUse", tool_name: "Read" }),
    )!;
    expect(toCapture(ok)).toBeUndefined();
    const start = parseHookInput(payload({ hook_event_name: "SessionStart" }))!;
    expect(toCapture(start)).toBeUndefined();
  });

  it("names an unknown tool when the payload has none", () => {
    const input = parseHookInput(
      payload({ hook_event_name: "PostToolUseFailure" }),
    )!;
    expect(toCapture(input)).toEqual({
      kind: "tool",
      toolName: "unknown",
      isError: true,
      message: "",
    });
  });
});

describe("toToolCall", () => {
  it("keys a failed command and its later success the same way", () => {
    const failure = callOutcome(toToolCall(bashFailure)!);
    const success = callOutcome(
      toToolCall(
        parseHookInput(
          payload({
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_input: { command: "pnpm  test" },
            tool_output: "3 passed",
          }),
        )!,
      )!,
    );
    expect(failure).toEqual({ ok: false, key: "command:pnpm test" });
    expect(success.ok && success.keys).toContain("command:pnpm test");
  });

  it("keys a tool failure by the tool", () => {
    const input = parseHookInput(
      payload({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Read",
        error: "nope",
      }),
    )!;
    expect(toToolCall(input)).toEqual({
      toolName: "Read",
      isError: true,
      text: "nope",
    });
  });

  it("reads a PostToolUse exit code as a failure", () => {
    const input = parseHookInput(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "make" },
        tool_response: { stdout: "", stderr: "", returnCode: 3 },
      }),
    )!;
    expect(callOutcome(toToolCall(input)!)).toEqual({
      ok: false,
      key: "command:make",
    });
  });

  it("is undefined for events that are not tool results", () => {
    expect(
      toToolCall(
        parseHookInput(payload({ hook_event_name: "UserPromptSubmit" }))!,
      ),
    ).toBeUndefined();
  });

  it("defaults the tool name and output", () => {
    const input = parseHookInput(payload({ hook_event_name: "PostToolUse" }))!;
    expect(toToolCall(input)).toEqual({
      toolName: "unknown",
      isError: false,
      text: "",
    });
    const failed = parseHookInput(
      payload({ hook_event_name: "PostToolUseFailure" }),
    )!;
    expect(toToolCall(failed)).toEqual({
      toolName: "unknown",
      isError: true,
      text: "",
    });
  });
});

describe("issue #131: a call whose pipeline reported success", () => {
  const bash = (fields: Record<string, unknown>) =>
    parseHookInput(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        ...fields,
      }),
    ) as HookInput;

  it("reads Exit code N out of a PostToolUse result text", () => {
    const input = bash({
      tool_input: { command: "make" },
      tool_response: {
        stdout: "Exit code 2\nmake: *** [all] Error 2",
        stderr: "",
      },
    });
    expect(toCapture(input)).toEqual({
      kind: "command",
      toolName: "Bash",
      command: "make",
      text: "make: *** [all] Error 2\n[exit code: 2]",
    });
    expect(callOutcome(toToolCall(input)!)).toEqual({
      ok: false,
      key: "command:make",
    });
  });

  it("fingerprints the result text and the error wording the same", () => {
    const signature = (input: HookInput) =>
      classify(toCapture(input)!, new TransientCounter())?.record.signature;
    const fromResult = bash({
      tool_input: { command: "npm test" },
      tool_response: { stdout: "Exit code 1\nnpm ERR! code ELIFECYCLE" },
    });
    const fromError = parseHookInput(
      payload({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        error: "Exit code 1\nnpm ERR! code ELIFECYCLE",
      }),
    ) as HookInput;
    expect(signature(fromResult)).toBe(signature(fromError));
  });

  it("reads every wording Claude Code puts the code in", () => {
    // The classifier inside Claude Code's own Bash tool words a non-zero exit
    // this way; its hooks reference shows the second one. Both lead the text,
    // as `Exit code N` does.
    const classifier = parseHookInput(
      payload({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        error: "Command failed with exit code 2",
      }),
    ) as HookInput;
    expect(toCapture(classifier)).toEqual({
      kind: "command",
      toolName: "Bash",
      command: "npm test",
      text: "Command failed with exit code 2\n[exit code: 2]",
    });
    expect(
      classify(toCapture(classifier)!, new TransientCounter())?.record.message,
    ).toBe("npm test → Command failed with exit code 2");

    const documented = parseHookInput(
      payload({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        error:
          "Command exited with non-zero status code 1\nnpm ERR! code ELIFECYCLE",
      }),
    ) as HookInput;
    expect(toCapture(documented)).toMatchObject({
      command: "npm test",
      text: "npm ERR! code ELIFECYCLE\n[exit code: 1]",
    });
  });

  it("infers a failure when the pipeline's status is its last command's", () => {
    const input = bash({
      tool_input: { command: "npm test 2>&1 | tail -15" },
      tool_response: { stdout: "npm ERR! code ELIFECYCLE", stderr: "" },
    });
    expect(input.inferredFailure).toBe(true);
    expect(toCapture(input)).toEqual({
      kind: "command",
      toolName: "Bash",
      command: "npm test 2>&1 | tail -15",
      text: "npm ERR! code ELIFECYCLE\n[exit code: 1]",
    });
    // The failed call stops taking the success path, so it can no longer
    // resolve another entry's watch under the same command line.
    expect(callOutcome(toToolCall(input)!)).toEqual({
      ok: false,
      key: "command:npm test 2>&1 | tail -15",
    });
  });

  it("infers a failure from a real piped run that ends on its summary", () => {
    const input = bash({
      tool_input: { command: "npm test 2>&1 | tail -15" },
      tool_response: {
        stdout: TAP_FAILED,
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    });
    expect(input.inferredFailure).toBe(true);
    expect(toCapture(input)).toEqual({
      kind: "command",
      toolName: "Bash",
      command: "npm test 2>&1 | tail -15",
      text: `${TAP_FAILED}\n[exit code: 1]`,
    });
    expect(callOutcome(toToolCall(input)!)).toEqual({
      ok: false,
      key: "command:npm test 2>&1 | tail -15",
    });
  });

  it("infers nothing for a command that only displays text", () => {
    const input = bash({
      tool_input: { command: "cat package.json | grep -i error" },
      tool_response: { stdout: `"error": "Cannot find module x"` },
    });
    expect(input.inferredFailure).toBeUndefined();
    expect(toCapture(input)).toBeUndefined();
  });

  it("never second-guesses an exit code the result reports", () => {
    const input = bash({
      tool_input: { command: "npm test 2>&1 | tail -15" },
      tool_response: { stdout: "npm ERR! code ELIFECYCLE", exit_code: 0 },
    });
    expect(input.exitCode).toBe(0);
    expect(input.inferredFailure).toBeUndefined();
    expect(toCapture(input)).toBeUndefined();
  });

  it("infers nothing for a non-shell tool, or a shell call with no command", () => {
    const read = bash({
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      tool_output: "Error: Cannot find module x",
    });
    expect(read.inferredFailure).toBeUndefined();
    expect(toCapture(read)).toBeUndefined();
    const bare = bash({ tool_output: "Error: Cannot find module x" });
    expect(bare.inferredFailure).toBeUndefined();
    expect(toCapture(bare)).toBeUndefined();
  });
});

describe("hookResponse", () => {
  it("wraps notices as additionalContext, one per line", () => {
    const out = hookResponse("PostToolUseFailure", [
      "[antibody] E-0001 known",
      "",
      "  ",
      "second",
    ]);
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: "[antibody] E-0001 known\nsecond",
      },
    });
  });

  it("says nothing when there is nothing to say", () => {
    expect(hookResponse("PostToolUse", [])).toBe("");
    expect(hookResponse("PostToolUse", ["", " "])).toBe("");
  });

  it("says nothing on an event that cannot carry context", () => {
    expect(hookResponse("SessionEnd", ["[antibody] bye"])).toBe("");
  });

  it("answers every event that can carry context", () => {
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
    ] as const)
      expect(
        JSON.parse(hookResponse(event, ["x"])).hookSpecificOutput.hookEventName,
      ).toBe(event);
  });

  it("stays inside Claude Code's limit", () => {
    const out = hookResponse("PostToolUse", ["y".repeat(30_000)]);
    const context = JSON.parse(out).hookSpecificOutput
      .additionalContext as string;
    expect(Array.from(context)).toHaveLength(ADDITIONAL_CONTEXT_MAX_CHARS);
  });
});
