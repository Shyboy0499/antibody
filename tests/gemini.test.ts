import { describe, expect, it } from "vitest";
import { TransientCounter, classify } from "../src/capture";
import {
  GEMINI_CONTEXT_MAX_CHARS,
  geminiResponse,
  parseGeminiInput,
  shellResult,
} from "../src/gemini";
import { parseHookInput } from "../src/claude-code";
import { toCapture, toToolCall } from "../src/hook-input";
import type { HookInput } from "../src/hook-input";

const base = {
  session_id: "4a1c",
  transcript_path: "/tmp/gemini/chat.json",
  cwd: "/work/repo",
  timestamp: "2026-10-05T10:00:00.000Z",
};
const parse = (fields: Record<string, unknown>) =>
  parseGeminiInput(JSON.stringify({ ...base, ...fields }));

// What Gemini CLI 0.62.0's run_shell_command returns for a failing command.
const shellFailure = [
  "<untrusted_context>",
  "Output: > repo@1.0.0 test",
  "> vitest run",
  "",
  "Error: Environment variable not found: DATABASE_URL.",
  "Exit Code: 1",
  "Process Group PGID: 48213",
  "</untrusted_context>",
].join("\n");
const afterShell = (llmContent: unknown, extra: object = {}) =>
  parse({
    hook_event_name: "AfterTool",
    tool_name: "run_shell_command",
    tool_input: { command: "pnpm test", description: "Run the tests" },
    tool_response: { llmContent, returnDisplay: "…", ...extra },
  });
// The same call, with the command the agent wrote: a pipeline's status is its
// last stage's, so what Gemini reports for one is not the tests' status (#131).
const shellCall = (command: string, llmContent: unknown) =>
  parse({
    hook_event_name: "AfterTool",
    tool_name: "run_shell_command",
    tool_input: { command, description: "Run the tests" },
    tool_response: { llmContent, returnDisplay: "…" },
  });
// What Gemini 0.62.0 returns for a failing `pnpm test 2>&1 | tail -15`: the
// status line is the tail's, and the error is the command's own.
const pipedFailure = [
  "<untrusted_context>",
  "Output: > repo@1.0.0 test",
  "> vitest run",
  "",
  "Error: Environment variable not found: DATABASE_URL.",
  "Exit Code: 0",
  "Process Group PGID: 48213",
  "</untrusted_context>",
].join("\n");

describe("parseGeminiInput: events", () => {
  it("maps Gemini's events onto antibody's", () => {
    expect(
      parse({ hook_event_name: "SessionStart", source: "startup" }),
    ).toEqual({
      event: "SessionStart",
      sessionId: "4a1c",
      cwd: "/work/repo",
      transcriptPath: "/tmp/gemini/chat.json",
    });
    expect(parse({ hook_event_name: "BeforeAgent", prompt: "fix it" })).toEqual(
      {
        event: "UserPromptSubmit",
        sessionId: "4a1c",
        cwd: "/work/repo",
        transcriptPath: "/tmp/gemini/chat.json",
      },
    );
    expect(parse({ hook_event_name: "SessionEnd", reason: "exit" })).toEqual({
      event: "SessionEnd",
      sessionId: "4a1c",
      cwd: "/work/repo",
      transcriptPath: "/tmp/gemini/chat.json",
    });
  });

  it("reads nothing it cannot use", () => {
    for (const text of [
      "{",
      "[]",
      JSON.stringify({ ...base, hook_event_name: "BeforeTool" }),
      JSON.stringify({ ...base, hook_event_name: "constructor" }),
      JSON.stringify({ ...base, hook_event_name: 3 }),
      JSON.stringify({ ...base, hook_event_name: "AfterTool", session_id: "" }),
      JSON.stringify({ hook_event_name: "AfterTool", session_id: "s" }),
    ])
      expect(parseGeminiInput(text), text).toBeUndefined();
  });
});

describe("parseGeminiInput: tool results", () => {
  it("reads a failing shell command's exit code and its own output", () => {
    const input = afterShell(shellFailure);
    expect(input).toEqual({
      event: "PostToolUse",
      sessionId: "4a1c",
      cwd: "/work/repo",
      transcriptPath: "/tmp/gemini/chat.json",
      toolName: "run_shell_command",
      command: "pnpm test",
      output:
        "> repo@1.0.0 test\n> vitest run\n\nError: Environment variable not found: DATABASE_URL.",
      exitCode: 1,
    });
    const capture = toCapture(input as HookInput);
    expect(capture).toEqual({
      kind: "command",
      toolName: "run_shell_command",
      command: "pnpm test",
      text: "> repo@1.0.0 test\n> vitest run\n\nError: Environment variable not found: DATABASE_URL.\n[exit code: 1]",
    });
    // The same failure reported by Claude Code gets the same fingerprint, so
    // a mixed fleet shares one entry for it.
    const claude = parseHookInput(
      JSON.stringify({
        ...base,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        error:
          "Exit code 1\n> repo@1.0.0 test\n> vitest run\n\nError: Environment variable not found: DATABASE_URL.",
      }),
    );
    const sign = (hook: HookInput) =>
      classify(toCapture(hook)!, new TransientCounter())?.record;
    expect(sign(input as HookInput)?.message).toBe(
      "pnpm test → Error: Environment variable not found: DATABASE_URL.",
    );
    expect(sign(input as HookInput)?.signature).toBe(
      sign(claude as HookInput)?.signature,
    );
  });

  it("treats a shell command without an exit code as a success", () => {
    const input = afterShell(
      "<untrusted_context>\nOutput: 12 passed\nProcess Group PGID: 7\n</untrusted_context>",
    );
    expect(input).toMatchObject({ event: "PostToolUse", output: "12 passed" });
    expect(input?.exitCode).toBeUndefined();
    expect(toCapture(input as HookInput)).toBeUndefined();
    expect(afterShell("Output: (empty)")?.output).toBe("");
  });

  it("infers a failure for a shell result that carries no exit code", () => {
    const input = afterShell(
      [
        "<untrusted_context>",
        "Output: npm ERR! code ELIFECYCLE",
        "Process Group PGID: 7",
        "</untrusted_context>",
      ].join("\n"),
    );
    expect(input?.exitCode).toBeUndefined();
    expect(input?.inferredFailure).toBe(true);
    expect(toCapture(input as HookInput)).toMatchObject({
      kind: "command",
      command: "pnpm test",
      text: "npm ERR! code ELIFECYCLE\n[exit code: 1]",
    });
  });

  it("never infers a failure an Exit Code line already settles", () => {
    const reported = afterShell(shellFailure);
    expect(reported?.inferredFailure).toBeUndefined();
    const succeeded = afterShell(
      "<untrusted_context>\nOutput: npm ERR! code ELIFECYCLE\nExit Code: 0\n</untrusted_context>",
    );
    expect(succeeded?.exitCode).toBe(0);
    expect(succeeded?.inferredFailure).toBeUndefined();
    expect(toCapture(succeeded as HookInput)).toBeUndefined();
  });

  it("infers a piped failure the zero of its last stage cannot settle", () => {
    const input = shellCall("pnpm test 2>&1 | tail -15", pipedFailure);
    // The line is the tail's status, not the tests': the output decides.
    expect(input?.exitCode).toBe(0);
    expect(input?.inferredFailure).toBe(true);
    const capture = toCapture(input as HookInput);
    expect(capture).toMatchObject({
      kind: "command",
      command: "pnpm test 2>&1 | tail -15",
      text: "> repo@1.0.0 test\n> vitest run\n\nError: Environment variable not found: DATABASE_URL.\n[exit code: 1]",
    });
    // The same failure in Claude Code's words gets the same signature, so a
    // mixed fleet shares one entry (#131).
    const claude = parseHookInput(
      JSON.stringify({
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test 2>&1 | tail -15" },
        tool_response: {
          stdout:
            "> repo@1.0.0 test\n> vitest run\n\nError: Environment variable not found: DATABASE_URL.",
          stderr: "",
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      }),
    );
    const sign = (hook: HookInput) =>
      classify(toCapture(hook)!, new TransientCounter())?.record;
    expect(sign(input as HookInput)?.signature).toBe(
      sign(claude as HookInput)?.signature,
    );
  });

  it("leaves a piped success alone, and a zero for a pipeline that prints nothing", () => {
    const succeeded = shellCall(
      "pnpm test 2>&1 | tail -15",
      "<untrusted_context>\nOutput: 12 passed\nExit Code: 0\n</untrusted_context>",
    );
    expect(succeeded?.inferredFailure).toBeUndefined();
    expect(toCapture(succeeded as HookInput)).toBeUndefined();
    // Nothing failure-like in the output: the silent case no output rule can
    // reach, whatever the code says.
    const quiet = shellCall(
      "node -e 'process.exit(3)' 2>&1 | tail -5",
      "<untrusted_context>\nOutput: 2\nExit Code: 0\n</untrusted_context>",
    );
    expect(quiet?.inferredFailure).toBeUndefined();
    expect(toCapture(quiet as HookInput)).toBeUndefined();
  });

  it("does not second-guess a zero for a command that is not a pipeline", () => {
    const plain = shellCall(
      "pnpm test",
      "<untrusted_context>\nOutput: npm ERR! code ELIFECYCLE\nExit Code: 0\n</untrusted_context>",
    );
    expect(plain?.exitCode).toBe(0);
    expect(plain?.inferredFailure).toBeUndefined();
    expect(toCapture(plain as HookInput)).toBeUndefined();
  });

  it("reads a tool's reported error as a failure", () => {
    const input = parse({
      hook_event_name: "AfterTool",
      tool_name: "read_file",
      tool_input: { absolute_path: "/work/repo/.env" },
      tool_response: {
        llmContent: "Error: file not found",
        error: {
          message: "File not found: /work/repo/.env",
          type: "file_not_found",
        },
      },
    });
    expect(input).toEqual({
      event: "PostToolUseFailure",
      sessionId: "4a1c",
      cwd: "/work/repo",
      transcriptPath: "/tmp/gemini/chat.json",
      toolName: "read_file",
      error: "File not found: /work/repo/.env",
    });
    expect(toCapture(input as HookInput)).toEqual({
      kind: "tool",
      toolName: "read_file",
      isError: true,
      message: "File not found: /work/repo/.env",
    });
    expect(toToolCall(input as HookInput)).toMatchObject({ isError: true });
  });

  it("falls back to the content for an error without a message", () => {
    expect(
      afterShell("spawn failed", { error: { type: "shell_execute_error" } })
        ?.error,
    ).toBe("spawn failed");
  });

  it("ignores errors that are not failures", () => {
    for (const type of [
      "sandbox_expansion_required",
      "stop_execution",
      "policy_violation",
    ])
      expect(
        parse({
          hook_event_name: "AfterTool",
          tool_name: "write_file",
          tool_response: { llmContent: "…", error: { message: "x", type } },
        })?.event,
      ).toBe("PostToolUse");
  });

  it("reads content given as parts, and survives a missing response", () => {
    const parts = (llmContent: unknown) =>
      parse({
        hook_event_name: "AfterTool",
        tool_name: "web_fetch",
        tool_response: { llmContent },
      })?.output;
    expect(parts([{ text: "a" }, { text: "b" }])).toBe("a\nb");
    expect(parts({ text: "one part" })).toBe("one part");
    expect(parts({ inlineData: { mimeType: "image/png" } })).toBe(
      '{"inlineData":{"mimeType":"image/png"}}',
    );
    expect(parts(7)).toBe("");
    expect(
      parse({ hook_event_name: "AfterTool", tool_name: "x", tool_input: 1 }),
    ).toMatchObject({ event: "PostToolUse", output: "" });
  });
});

describe("shellResult", () => {
  it("keeps a negative exit code and text without the wrapper", () => {
    expect(shellResult("Output: boom\nExit Code: -2")).toEqual({
      exitCode: -2,
      output: "boom",
    });
  });
});

describe("geminiResponse", () => {
  it("answers in Gemini's own event names", () => {
    const answer = (event: Parameters<typeof geminiResponse>[0]) =>
      JSON.parse(geminiResponse(event, ["[antibody] E-0001 known"]));
    expect(answer("PostToolUse")).toEqual({
      hookSpecificOutput: {
        hookEventName: "AfterTool",
        additionalContext: "[antibody] E-0001 known",
      },
    });
    expect(answer("PostToolUseFailure").hookSpecificOutput.hookEventName).toBe(
      "AfterTool",
    );
    expect(answer("UserPromptSubmit").hookSpecificOutput.hookEventName).toBe(
      "BeforeAgent",
    );
    expect(answer("SessionStart").hookSpecificOutput.hookEventName).toBe(
      "SessionStart",
    );
  });

  it("says nothing at session end or without notices, and clips", () => {
    expect(geminiResponse("SessionEnd", ["x"])).toBe("");
    expect(geminiResponse("PostToolUse", [" ", ""])).toBe("");
    const long = JSON.parse(
      geminiResponse("PostToolUse", [
        "x".repeat(GEMINI_CONTEXT_MAX_CHARS + 50),
      ]),
    ).hookSpecificOutput.additionalContext as string;
    expect(Array.from(long)).toHaveLength(GEMINI_CONTEXT_MAX_CHARS);
  });
});

// The live check #135 tracks, and the evidence #149's review asked for: a real
// Gemini CLI session (0.63.0, on Windows, 2026-10-10) against the mock endpoint
// in scripts/step0, with a hook capturing every payload it sent. The
// `llmContent` strings below are that session's own, verbatim.
describe("the live payloads", () => {
  const live = (llmContent: string, command: string) =>
    parse({
      hook_event_name: "AfterTool",
      tool_name: "run_shell_command",
      tool_input: { command },
      tool_response: { llmContent, returnDisplay: "" },
    });

  it("reads a failing call: `Output: …`, then `Exit Code: N`", () => {
    const input = live(
      [
        "<untrusted_context>",
        "Output: 2",
        "Exit Code: 1",
        "Process Group PGID: 14012",
        "</untrusted_context>",
      ].join("\n"),
      'node -e "console.log(2); process.exit(3)"',
    );
    expect(input?.exitCode).toBe(1);
    expect(input?.output).toBe("2");
    expect(input?.inferredFailure).toBeUndefined();
    expect(toCapture(input as HookInput)).toEqual({
      kind: "command",
      toolName: "run_shell_command",
      command: 'node -e "console.log(2); process.exit(3)"',
      text: "2\n[exit code: 1]",
    });
  });

  it("reads a call that printed error-looking text and succeeded as a success", () => {
    // Display-only: what it printed is what the agent asked for, and the text
    // names an error all the same.
    const input = live(
      [
        "<untrusted_context>",
        'Output:     "test": "node -e \\"console.error(\'boom\'); process.exit(1)\\""',
        "Process Group PGID: 6508",
        "</untrusted_context>",
      ].join("\n"),
      "Get-Content package.json | Select-String -Pattern error",
    );
    expect(input?.exitCode).toBeUndefined();
    expect(input?.inferredFailure).toBeUndefined();
    expect(toCapture(input as HookInput)).toBeUndefined();
  });

  it("infers a piped failure the harness reported no code for at all", () => {
    // The shape a POSIX shell leaves when the pipeline's last stage earns the
    // zero. There is no `Exit Code` line for it - the shell tool pushes that
    // line only when `result.exitCode !== 0` (0.62.0, live-confirmed on
    // 0.63.0) - so the shared output rule is its only reader.
    const input = live(
      [
        "<untrusted_context>",
        "Output: > repo@1.0.0 test",
        "> node --test",
        "",
        "✖ test/validate.test.js (72.3ms)",
        "ℹ fail 7",
        "</untrusted_context>",
      ].join("\n"),
      "npm test 2>&1 | tail -15",
    );
    expect(input?.exitCode).toBeUndefined();
    expect(input?.inferredFailure).toBe(true);
    expect(toCapture(input as HookInput)).toMatchObject({
      kind: "command",
      toolName: "run_shell_command",
      text: expect.stringContaining("[exit code: 1]"),
    });
  });
});
