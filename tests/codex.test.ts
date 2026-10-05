import { describe, expect, it } from "vitest";
import { TransientCounter, classify } from "../src/capture";
import { parseHookInput } from "../src/claude-code";
import { INFERRED_EXIT_CODE, looksFailed, parseCodexInput } from "../src/codex";
import { toCapture } from "../src/hook-input";
import type { HookInput } from "../src/hook-input";

const base = {
  session_id: "019a-codex",
  transcript_path: null,
  cwd: "/work/repo",
  model: "gpt-5.5-codex",
  permission_mode: "default",
  turn_id: "t-3",
};
const parse = (fields: Record<string, unknown>) =>
  parseCodexInput(JSON.stringify({ ...base, ...fields }));
const bash = (command: string, output: unknown) =>
  parse({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: output,
    tool_use_id: "call_1",
  });

const ERROR = "Error: Environment variable not found: DATABASE_URL.";

describe("parseCodexInput", () => {
  it("reads the session events under Claude Code's names", () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"])
      expect(parse({ hook_event_name: event })).toEqual({
        event,
        sessionId: "019a-codex",
        cwd: "/work/repo",
      });
  });

  it("reads nothing it cannot use", () => {
    for (const text of [
      "{",
      "null",
      JSON.stringify({ ...base, hook_event_name: "PreToolUse" }),
      JSON.stringify({ ...base, hook_event_name: "Stop" }),
      JSON.stringify({
        ...base,
        hook_event_name: "PostToolUse",
        session_id: "",
      }),
      JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s" }),
    ])
      expect(parseCodexInput(text), text).toBeUndefined();
  });

  it("infers a failed shell command from its output, with exit code 1", () => {
    const input = bash("pnpm test", `> vitest run\n\n${ERROR}\n`);
    expect(input).toEqual({
      event: "PostToolUse",
      sessionId: "019a-codex",
      cwd: "/work/repo",
      toolName: "Bash",
      command: "pnpm test",
      output: `> vitest run\n\n${ERROR}\n`,
      exitCode: INFERRED_EXIT_CODE,
    });
    // The same failure from Claude Code gets the same fingerprint.
    const claude = parseHookInput(
      JSON.stringify({
        ...base,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        error: `Exit code 1\n> vitest run\n\n${ERROR}`,
      }),
    );
    const sign = (hook: HookInput) =>
      classify(toCapture(hook)!, new TransientCounter())?.record.signature;
    expect(sign(input as HookInput)).toBe(sign(claude as HookInput));
  });

  it("treats other shell output as a success", () => {
    const input = bash("pnpm test", "Tests  12 passed (12)\n");
    expect(input?.exitCode).toBeUndefined();
    expect(toCapture(input as HookInput)).toBeUndefined();
    expect(
      bash("cat .env.example", "Error: placeholder")?.exitCode,
    ).toBeUndefined();
  });

  it("reads an MCP tool's error result as a failure", () => {
    const input = parse({
      hook_event_name: "PostToolUse",
      tool_name: "mcp__db__query",
      tool_input: { sql: "select 1" },
      tool_response: {
        content: [
          { type: "text", text: "connect ECONNREFUSED 127.0.0.1:5432" },
        ],
        isError: true,
      },
      tool_use_id: "call_2",
      agent_id: "sub-1",
    });
    expect(input).toEqual({
      event: "PostToolUseFailure",
      sessionId: "019a-codex",
      cwd: "/work/repo",
      agentId: "sub-1",
      toolName: "mcp__db__query",
      error: "connect ECONNREFUSED 127.0.0.1:5432",
    });
  });

  it("reads responses given as content items, objects or nothing", () => {
    const output = (tool_response: unknown) =>
      parse({
        hook_event_name: "PostToolUse",
        tool_name: "view_image",
        tool_input: 3,
        tool_response,
      })?.output;
    expect(output([{ type: "input_text", text: "a" }, { text: "b" }])).toBe(
      "a\nb",
    );
    expect(output({ text: "one" })).toBe("one");
    expect(output({ content: [{ text: "inner" }] })).toBe("inner");
    expect(output({ ok: true })).toBe('{"ok":true}');
    expect(output(null)).toBe("");
    expect(output(undefined)).toBe("");
  });
});

describe("looksFailed", () => {
  it.each([
    ["cargo build", "error[E0308]: mismatched types"],
    ["cargo build", "error: could not compile `app`"],
    [
      "git push",
      "fatal: not a git repository (or any parent up to mount point /)",
    ],
    ["node app.js", "TypeError: Cannot read properties of undefined"],
    [
      "python app.py",
      "Traceback (most recent call last):\n  …\nModuleNotFoundError: No module named 'flask'",
    ],
    ["pnpm dev", "bash: pnpm: command not found"],
    ["source .env", "bash: .env: No such file or directory"],
    ["./deploy.sh", "./deploy.sh: Permission denied"],
    ["npm test", "npm ERR! code ELIFECYCLE"],
    [
      "pnpm install",
      " ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND  No package.json found",
    ],
    ["pnpm test", "FAIL  src/a.test.ts > adds"],
    ["pnpm test", "      Tests  1 failed | 635 passed (636)"],
    ["make", "make: *** [Makefile:3: all] Error 2"],
    ["make -C lib", "make[1]: *** [build] Error 1"],
  ])("%s ending in %j", (command, output) => {
    expect(looksFailed(command, output)).toBe(true);
  });

  it.each([
    ["pnpm test", "Tests  636 passed (636)"],
    [
      "pnpm build",
      "Error handling was improved in this release.\nDone in 1.2s",
    ],
    ["pnpm build", ""],
    ["grep -rn Error: src", "src/a.ts:3: Error: boom"],
    ["git log -1", "fatal: bad revision"],
    ["tail -1 build.log", "error: could not compile"],
    [undefined, "12 passed"],
  ])("%s ending in %j", (command, output) => {
    expect(looksFailed(command, output)).toBe(false);
  });

  it("still reads git commands that do more than display", () => {
    expect(looksFailed("git push", "fatal: no upstream configured")).toBe(true);
  });
});
