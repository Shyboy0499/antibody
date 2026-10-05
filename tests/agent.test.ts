import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_NAME_MAX_CHARS, agentName, worktreeRoot } from "../src/agent";

describe("agentName", () => {
  it("names an agent after its harness and worktree by default", () => {
    expect(agentName("claude-code", join("/work", "agent-a"), {})).toBe(
      "claude-code@agent-a",
    );
  });

  it("takes ANTIBODY_AGENT when an orchestrator sets it", () => {
    expect(
      agentName("claude-code", "/work/agent-a", {
        ANTIBODY_AGENT: "  reviewer\n2 ",
      }),
    ).toBe("reviewer 2");
  });

  it("ignores a blank ANTIBODY_AGENT", () => {
    expect(agentName("codex", "/work/b", { ANTIBODY_AGENT: "   " })).toBe(
      "codex@b",
    );
  });

  it("uses the whole path when it has no last segment", () => {
    expect(agentName("gemini", "/", {})).toBe("gemini@/");
  });

  it("clips long names", () => {
    const name = agentName("claude-code", "/w", {
      ANTIBODY_AGENT: "x".repeat(500),
    });
    expect(Array.from(name)).toHaveLength(AGENT_NAME_MAX_CHARS);
  });
});

describe("worktreeRoot", () => {
  let root: string;
  let repo: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-agent-")));
    repo = join(root, "agent-a");
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the worktree root from a subdirectory", () => {
    expect(worktreeRoot(join(repo, "src", "deep"))).toBe(repo);
  });

  it("falls back to the directory itself outside a repository", () => {
    const fail = () => {
      throw new Error("fatal: not a git repository");
    };
    expect(worktreeRoot("/somewhere", fail)).toBe("/somewhere");
    expect(worktreeRoot("/somewhere", () => "")).toBe("/somewhere");
  });
});
