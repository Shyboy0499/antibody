import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_DIR_NAME, NotInGitRepoError, memoryDir } from "../src/paths";

// Real repositories in a temporary directory: the point of memoryDir() is what
// git itself reports for a main checkout and its linked worktrees.
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
let main: string;
let worktreeA: string;
let worktreeB: string;
let outside: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-memory-dir-")));
  main = join(root, "repo");
  worktreeA = join(root, "agent-a");
  worktreeB = join(root, "agent-b");
  outside = join(root, "not-a-repo");
  mkdirSync(main);
  mkdirSync(outside);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "fixture\n");
  git(main, "add", "README.md");
  git(main, "commit", "-q", "-m", "fixture");
  git(main, "worktree", "add", "-q", "-b", "task-a", worktreeA);
  git(main, "worktree", "add", "-q", "-b", "task-b", worktreeB);
  mkdirSync(join(worktreeA, "src", "deep"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("memoryDir", () => {
  it("is the antibody directory inside the git common directory", () => {
    expect(memoryDir(main)).toBe(join(main, ".git", MEMORY_DIR_NAME));
  });

  it("is the same from every linked worktree", () => {
    expect(memoryDir(worktreeA)).toBe(memoryDir(main));
    expect(memoryDir(worktreeB)).toBe(memoryDir(main));
  });

  it("is the same from a subdirectory of a worktree", () => {
    expect(memoryDir(join(worktreeA, "src", "deep"))).toBe(memoryDir(main));
  });

  it("refuses a directory outside any repository", () => {
    expect(() =>
      memoryDir(outside, () => {
        throw new Error("fatal: not a git repository");
      }),
    ).toThrow(NotInGitRepoError);
  });

  it("refuses when git reports no common directory", () => {
    expect(() => memoryDir(main, () => "")).toThrow(NotInGitRepoError);
  });

  it("names the directory it was asked about", () => {
    try {
      memoryDir(outside, () => {
        throw new Error("fatal: not a git repository");
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NotInGitRepoError);
      expect((error as NotInGitRepoError).cwd).toBe(outside);
      expect((error as Error).message).toContain(outside);
    }
  });
});
