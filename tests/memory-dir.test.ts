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
import { worktreeRoot } from "../src/agent";
import {
  MEMORY_DIR_NAME,
  NotInGitRepoError,
  findGitDirs,
  memoryDir,
  runGit,
} from "../src/paths";

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

describe("findGitDirs: reading .git instead of running git", () => {
  it("gives the answer git gives, from every checkout and subdirectory", () => {
    for (const dir of [
      main,
      worktreeA,
      worktreeB,
      join(worktreeA, "src", "deep"),
    ]) {
      expect(memoryDir(dir)).toBe(memoryDir(dir, runGit));
      expect(worktreeRoot(dir)).toBe(worktreeRoot(dir, runGit));
    }
    expect(findGitDirs(join(worktreeA, "src"))).toEqual({
      worktree: worktreeA,
      commonDir: join(main, ".git"),
    });
  });

  it("finds nothing outside a repository", () => {
    expect(findGitDirs(outside)).toBeUndefined();
    expect(() => memoryDir(outside)).toThrow(NotInGitRepoError);
    expect(worktreeRoot(outside)).toBe(outside);
  });

  it("treats a .git file without commondir as its own common directory", () => {
    const module = join(root, "submodule");
    const gitdir = join(root, "modules", "lib");
    mkdirSync(module, { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(module, ".git"), `gitdir: ${gitdir}\n`);
    expect(findGitDirs(module)).toEqual({
      worktree: module,
      commonDir: gitdir,
    });
  });

  it("gives up on a .git file it cannot follow", () => {
    const junk = join(root, "junk");
    const dangling = join(root, "dangling");
    mkdirSync(junk);
    mkdirSync(dangling);
    writeFileSync(join(junk, ".git"), "not a pointer\n");
    writeFileSync(join(dangling, ".git"), `gitdir: ${join(root, "nowhere")}\n`);
    expect(findGitDirs(junk)).toBeUndefined();
    expect(findGitDirs(dangling)).toBeUndefined();
  });

  it("asks git when GIT_DIR moves the repository", () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(main, ".git");
    try {
      expect(memoryDir(outside)).toBe(join(main, ".git", MEMORY_DIR_NAME));
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});
