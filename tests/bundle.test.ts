import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/cli";

// dist/antibody.mjs is what the Claude Code plugin runs, straight from git.
// These tests run the committed file in a real process.
const bundle = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "dist",
  "antibody.mjs",
);
const run = (args: string[], input = "") =>
  execFileSync(process.execPath, [bundle, ...args], { input }).toString();

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-bundle-")));
  for (const dir of ["repo"]) mkdirSync(join(root, dir));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      { cwd: join(root, "repo"), stdio: "ignore" },
    );
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "a", join(root, "agent-a"));
  git("worktree", "add", "-q", "-b", "b", join(root, "agent-b"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const failure = (worktree: string, session: string) =>
  JSON.stringify({
    hook_event_name: "PostToolUseFailure",
    session_id: session,
    cwd: join(root, worktree),
    tool_name: "Bash",
    tool_input: { command: "pnpm dev" },
    error:
      "Exit code 1\nError: listen EADDRINUSE: address already in use :::3000",
  });

describe("the committed bundle", () => {
  it("prints the source's version", () => {
    expect(run(["--version"])).toBe(`${VERSION}\n`);
  });

  it("says nothing outside a repository", () => {
    const start = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "s",
      cwd: root,
    });
    expect(run(["hook", "claude-code"], start)).toBe("");
  });

  it("runs a real hook exchange between two worktrees", () => {
    expect(run(["hook", "claude-code"], failure("agent-a", "s-a"))).toBe("");
    const out = JSON.parse(
      run(["hook", "claude-code"], failure("agent-b", "s-b")),
    );
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "claude-code@agent-a has been diagnosing this",
    );
  });
});

describe("the committed bundle as an MCP server", () => {
  const line = (id: number, method: string) =>
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`;

  it("answers over stdio", () => {
    const responses = run(
      ["mcp", "claude-code"],
      line(1, "initialize") + line(2, "tools/list"),
    )
      .trim()
      .split("\n")
      .map((text) => JSON.parse(text));
    expect(responses.map((r) => r.id).sort()).toEqual([1, 2]);
    const list = responses.find((r) => r.id === 2);
    expect(list.result.tools).toHaveLength(5);
  });

  it("exits quietly when the client closes its end of the pipe", async () => {
    const child = spawn(process.execPath, [bundle, "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // The server may be gone before the last pings are written.
    child.stdin.on("error", () => {});
    child.stdout.once("data", () => {
      child.stdout.destroy();
      for (let id = 2; id < 200; id++) child.stdin.write(line(id, "ping"));
      child.stdin.end();
    });
    child.stdin.write(line(1, "ping"));
    const code = await new Promise((done) => child.on("exit", done));
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  });
});
