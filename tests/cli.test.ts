import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOOK_DEADLINE_MS, VERSION, main, runHook } from "../src/cli";
import type { CliIo, HookDeps, McpDeps } from "../src/cli";
import { readEventsFrom } from "../src/events";
import type { Fleet } from "../src/fleet";
import { filesIn, memoryDir } from "../src/paths";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=antibody-test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    { cwd, stdio: "ignore" },
  );

let root: string;
let repo: string;
let agentA: string;
let agentB: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-cli-")));
  repo = join(root, "repo");
  agentA = join(root, "agent-a");
  agentB = join(root, "agent-b");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "fixture");
  git(repo, "worktree", "add", "-q", "-b", "task-a", agentA);
  git(repo, "worktree", "add", "-q", "-b", "task-b", agentB);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

async function hook(
  stdin: string,
  env: NodeJS.ProcessEnv = {},
  deps: HookDeps = {},
): Promise<Run> {
  let out = "";
  let err = "";
  const io: CliIo = {
    readStdin: async () => stdin,
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    env,
  };
  const code = await runHook("claude-code", io, deps);
  return { code, out, err };
}

const payload = (
  cwd: string,
  session: string,
  fields: Record<string, unknown>,
) =>
  JSON.stringify({
    session_id: session,
    cwd,
    transcript_path: "/t",
    ...fields,
  });
const failure = (cwd: string, session: string) =>
  payload(cwd, session, {
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    error: "Exit code 1\nError: Environment variable not found: DATABASE_URL.",
  });
const context = (run: Run) =>
  JSON.parse(run.out).hookSpecificOutput.additionalContext as string;

describe("antibody hook claude-code", () => {
  it("records a new error silently, then tells the next agent who is on it", async () => {
    expect(await hook(failure(agentA, "s-a"))).toEqual({
      code: 0,
      out: "",
      err: "",
    });
    const second = await hook(failure(agentB, "s-b"));
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out).hookSpecificOutput.hookEventName).toBe(
      "PostToolUseFailure",
    );
    expect(context(second)).toMatch(
      /^\[antibody\] E-0001: claude-code@agent-a has been diagnosing this for \d+ s\./,
    );
  });

  it("asks for the fix when the same command then succeeds", async () => {
    const run = await hook(
      payload(agentA, "s-a", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        tool_output: "12 passed",
      }),
    );
    expect(context(run)).toContain(
      "E-0001 looks resolved. Record the fix with antibody_record",
    );
  });

  it("starts a turn on a prompt and passes the session start through", async () => {
    for (const event of ["UserPromptSubmit", "SessionStart"])
      expect(
        await hook(payload(agentB, "s-b", { hook_event_name: event })),
      ).toEqual({
        code: 0,
        out: "",
        err: "",
      });
  });

  it("releases the session's claims when it ends", async () => {
    await hook(
      payload(agentA, "s-a", {
        hook_event_name: "SessionEnd",
        reason: "other",
      }),
    );
    const claims = readFileSync(join(memoryDir(repo), "claims.json"), "utf8");
    expect(claims).not.toContain("s-a");
  });

  it("names the agent from ANTIBODY_AGENT when it is set", async () => {
    await hook(
      payload(agentA, "s-c", {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Read",
        error: "File does not exist.",
      }),
      { ANTIBODY_AGENT: "reviewer" },
    );
    const run = await hook(
      payload(agentB, "s-d", {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Read",
        error: "File does not exist.",
      }),
    );
    expect(context(run)).toContain("reviewer has been diagnosing this");
  });
});

describe("the hook fails open", () => {
  const stuck: HookDeps = {
    fleet: () =>
      ({
        poll: () => new Promise<string[]>(() => undefined),
      }) as unknown as Fleet,
  };
  const broken: HookDeps = {
    fleet: () => {
      throw new Error("disk on fire");
    },
  };
  const start = (cwd: string) =>
    payload(cwd, "s-x", { hook_event_name: "SessionStart" });

  it("says nothing for a payload it cannot read", async () => {
    expect(await hook("{nope")).toEqual({ code: 0, out: "", err: "" });
  });

  it("says nothing outside a git repository", async () => {
    expect(await hook(start(root))).toEqual({ code: 0, out: "", err: "" });
  });

  it("says nothing on an internal error, and explains it only in debug mode", async () => {
    expect(await hook(start(agentA), {}, broken)).toEqual({
      code: 0,
      out: "",
      err: "",
    });
    const debug = await hook(start(agentA), { ANTIBODY_DEBUG: "1" }, broken);
    expect(debug).toEqual({
      code: 0,
      out: "",
      err: "antibody: disk on fire\n",
    });
  });

  it("says nothing when it runs past its deadline", async () => {
    expect(HOOK_DEADLINE_MS).toBe(3_000);
    const run = await hook(
      start(agentA),
      { ANTIBODY_DEBUG: "1" },
      { ...stuck, deadlineMs: 20 },
    );
    expect(run).toEqual({
      code: 0,
      out: "",
      err: "antibody: hook ran past its deadline; said nothing\n",
    });
    expect(await hook(start(agentA), {}, { ...stuck, deadlineMs: 20 })).toEqual(
      {
        code: 0,
        out: "",
        err: "",
      },
    );
  });

  it("says nothing for a harness it does not know", async () => {
    let err = "";
    const io: CliIo = {
      readStdin: async () => start(agentA),
      stdout: () => undefined,
      stderr: (t) => void (err += t),
      env: { ANTIBODY_DEBUG: "1" },
    };
    expect(await runHook("vim", io)).toBe(0);
    expect(err).toBe("antibody: unknown harness: vim\n");
  });

  it("reports a non-Error throw in debug mode", async () => {
    const odd: HookDeps = {
      fleet: () => {
        throw "plain string";
      },
    };
    const run = await hook(start(agentA), { ANTIBODY_DEBUG: "1" }, odd);
    expect(run.err).toBe("antibody: plain string\n");
  });
});

describe("main", () => {
  const run = async (...argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(argv, {
      readStdin: async () => "",
      stdout: (t) => void (out += t),
      stderr: (t) => void (err += t),
      env: {},
    });
    return { code, out, err };
  };

  it("prints the version", async () => {
    expect(await run("--version")).toEqual({
      code: 0,
      out: `${VERSION}\n`,
      err: "",
    });
    expect((await run("-v")).out).toBe(`${VERSION}\n`);
  });

  it("prints usage for --help, and for no command with exit code 2", async () => {
    expect((await run("--help")).code).toBe(0);
    expect((await run("-h")).out).toContain("antibody hook claude-code");
    expect((await run()).code).toBe(2);
  });

  it("refuses an unknown command", async () => {
    const result = await run("launch");
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown command: launch");
  });

  it("routes hook to the hook command, which never fails", async () => {
    expect((await run("hook")).code).toBe(0);
  });
});

describe("antibody mcp", () => {
  let mcpRoot: string;
  let wtA: string;
  let wtB: string;

  beforeAll(() => {
    mcpRoot = realpathSync(mkdtempSync(join(tmpdir(), "antibody-mcp-")));
    const main = join(mcpRoot, "repo");
    wtA = join(mcpRoot, "wt-a");
    wtB = join(mcpRoot, "wt-b");
    execFileSync("mkdir", ["-p", main]);
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "README.md"), "fixture\n");
    git(main, "add", "README.md");
    git(main, "commit", "-q", "-m", "fixture");
    git(main, "worktree", "add", "-q", "-b", "a", wtA);
    git(main, "worktree", "add", "-q", "-b", "b", wtB);
  });

  afterAll(() => {
    rmSync(mcpRoot, { recursive: true, force: true });
  });

  const rpc = (id: number, method: string, params: object = {}) => ({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  const serve = async (
    argv: string[],
    messages: object[],
    env: NodeJS.ProcessEnv = {},
    deps: McpDeps = {},
  ) => {
    const input = new PassThrough();
    let out = "";
    let err = "";
    const done = main(
      ["mcp", ...argv],
      {
        readStdin: async () => "",
        stdout: (t) => void (out += t),
        stderr: (t) => void (err += t),
        env,
      },
      { input, ...deps },
    );
    for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
    input.end();
    const code = await done;
    const responses = out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { id: number; result?: any });
    return { code, err, responses: responses.sort((a, b) => a.id - b.id) };
  };
  const textOf = (response: { result?: any }) =>
    response.result.content[0].text as string;

  it("serves the fleet's memory to another worktree's agent", async () => {
    // claude-code@wt-a's hook records a new error.
    expect((await hook(failure(wtA, "s-a"))).out).toBe("");
    const { code, err, responses } = await serve(
      ["claude-code"],
      [
        rpc(1, "initialize", { protocolVersion: "2025-06-18" }),
        { jsonrpc: "2.0", method: "notifications/initialized" },
        rpc(2, "tools/list"),
        rpc(3, "tools/call", {
          name: "antibody_lookup",
          arguments: { query: "Environment variable not found: DATABASE_URL" },
        }),
        rpc(4, "tools/call", {
          name: "antibody_record",
          arguments: { id: "E-0001", fix: "Copy .env from the main checkout." },
        }),
      ],
      { CLAUDE_CODE_SESSION_ID: "s-b" },
      { cwd: wtB },
    );
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(responses[0]!.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "antibody", version: VERSION },
    });
    expect(
      responses[1]!.result.tools.map((t: { name: string }) => t.name),
    ).toEqual([
      "antibody_lookup",
      "antibody_list",
      "antibody_record",
      "antibody_forget",
      "antibody_stats",
    ]);
    expect(textOf(responses[2]!)).toContain(
      "claude-code@wt-a has been diagnosing this",
    );
    expect(textOf(responses[3]!)).toBe(
      "Updated E-0001 (status fixed). Agents waiting for it get the fix at their next tool call.",
    );
    const fix = (
      await readEventsFrom(filesIn(memoryDir(wtA)).events)
    ).events.find((e) => e.kind === "fix");
    expect(fix).toMatchObject({ agent: "claude-code@wt-b", session: "s-b" });
  });

  it("names a harness-less agent and session after itself", async () => {
    await serve(
      [],
      [
        rpc(1, "tools/call", {
          name: "antibody_forget",
          arguments: { id: "E-0001", reason: "test" },
        }),
      ],
      {},
      { cwd: wtB, pid: 4242 },
    );
    const forget = (
      await readEventsFrom(filesIn(memoryDir(wtA)).events)
    ).events.find((e) => e.kind === "forget");
    expect(forget).toMatchObject({ agent: "mcp@wt-b", session: "mcp-4242" });
  });

  it("finds the project from CLAUDE_PROJECT_DIR, or the working directory", async () => {
    const fromEnv = await serve(
      ["cursor"],
      [rpc(1, "tools/call", { name: "antibody_stats" })],
      { CLAUDE_PROJECT_DIR: wtA },
    );
    expect(textOf(fromEnv.responses[0]!)).toContain(
      `Memory: ${memoryDir(wtA)}`,
    );
    const fromCwd = await serve(["cursor"], [rpc(1, "ping")]);
    expect(fromCwd.responses).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("answers outside a repository with a tool error", async () => {
    const { responses } = await serve(
      [],
      [rpc(1, "tools/call", { name: "antibody_list" })],
      {},
      { cwd: mcpRoot },
    );
    expect(responses[0]!.result).toEqual({
      content: [
        {
          type: "text",
          text: `antibody_list: not inside a git repository: ${mcpRoot}`,
        },
      ],
      isError: true,
    });
  });

  it("refuses a harness name that cannot be part of an agent name", async () => {
    const run = await serve(["Claude Code"], []);
    expect(run.code).toBe(2);
    expect(run.err).toContain("not a harness name: Claude Code");
  });
});
