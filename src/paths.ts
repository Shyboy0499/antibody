// Ported from dsh-errkb, src/paths.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Only the file layout comes over: the file names, the paths built
// from a directory, and the name for a copy of an unparseable document.
// dsh-errkb's directory tiers locate a DeepSeek Harness home; antibody finds its
// memory directory through the git common directory instead (memoryDir below).
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

/** The six file names the knowledge base directory holds. */
export const KB_FILE = {
  errors: "ANTIBODIES.md",
  archive: "ANTIBODIES.archive.md",
  index: "antibodies.index.json",
  state: "state.json",
  machine: ".machine.json",
  lock: ".lock",
} as const;

/** Absolute paths of the six files inside one knowledge base directory. */
export interface KbFiles {
  errors: string;
  archive: string;
  index: string;
  state: string;
  machine: string;
  lock: string;
}

/**
 * Build the six absolute file paths inside a knowledge base directory.
 *
 * @param dir - the resolved knowledge base directory.
 * @returns the file paths.
 */
export function filesIn(dir: string): KbFiles {
  return {
    errors: join(dir, KB_FILE.errors),
    archive: join(dir, KB_FILE.archive),
    index: join(dir, KB_FILE.index),
    state: join(dir, KB_FILE.state),
    machine: join(dir, KB_FILE.machine),
    lock: join(dir, KB_FILE.lock),
  };
}

/**
 * Name for the copy of a document that could not be parsed.
 *
 * Colons and dots are replaced so the name is legal on Windows, and the whole
 * stamp is derived from the argument so the caller can pin it in a test.
 *
 * @param now - timestamp to embed; defaults to the current time.
 * @returns a file name, never a path.
 */
export function corruptFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `ANTIBODIES.corrupt-${stamp}.md`;
}

// ---------------------------------------------------------------------------
// The memory directory
//
// Every linked worktree of a repository shares one common git directory, so a
// directory inside it is shared by every agent working on the repository, with
// no configuration and no server. It sits inside .git, so it is never
// committed by accident.

/** The directory inside the git common directory that holds antibody's memory. */
export const MEMORY_DIR_NAME = "antibody";

/** Runs git with `args` in `cwd` and returns its trimmed standard output. */
export type GitRunner = (args: string[], cwd: string) => string;

/** The real git, found on PATH. Its error output is discarded. */
export const runGit: GitRunner = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** `cwd` is not inside a git working tree, so there is no memory to share. */
export class NotInGitRepoError extends Error {
  constructor(readonly cwd: string) {
    super(`not inside a git repository: ${cwd}`);
    this.name = "NotInGitRepoError";
  }
}

/**
 * The memory directory for the repository `cwd` belongs to: the same path from
 * the main checkout, from any linked worktree and from any subdirectory.
 *
 * @param cwd - any directory inside the repository.
 * @param git - runs git; injected in tests.
 * @returns `<git common dir>/antibody`, absolute.
 * @throws NotInGitRepoError when `cwd` is not inside a repository.
 */
export function memoryDir(cwd: string, git: GitRunner = runGit): string {
  let common: string;
  try {
    common = git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd,
    );
  } catch {
    throw new NotInGitRepoError(cwd);
  }
  if (common === "") throw new NotInGitRepoError(cwd);
  return join(resolve(cwd, common), MEMORY_DIR_NAME);
}
