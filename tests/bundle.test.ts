import { execFileSync } from "node:child_process";
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
