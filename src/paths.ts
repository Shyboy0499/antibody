// Ported from dsh-errkb, src/paths.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Only the file layout comes over: the file names, the paths built
// from a directory, and the name for a copy of an unparseable document.
// dsh-errkb's directory tiers locate a DeepSeek Harness home; antibody finds its
// memory directory through the git common directory instead (memoryDir below).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The file names the memory directory holds. */
export const KB_FILE = {
  errors: "ANTIBODIES.md",
  archive: "ANTIBODIES.archive.md",
  index: "antibodies.index.json",
  state: "state.json",
  machine: ".machine.json",
  lock: ".lock",
  events: "events.jsonl",
  claims: "claims.json",
} as const;

/** Absolute paths of the files inside one memory directory. */
export interface KbFiles {
  errors: string;
  archive: string;
  index: string;
  state: string;
  machine: string;
  lock: string;
  events: string;
  claims: string;
}

/**
 * Build the absolute file paths inside a memory directory.
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
    events: join(dir, KB_FILE.events),
    claims: join(dir, KB_FILE.claims),
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

/** A worktree's root and its repository's common git directory. */
export interface GitDirs {
  worktree: string;
  commonDir: string;
}

/**
 * Find the repository `cwd` belongs to by reading `.git`, without starting
 * git: a hook runs on every tool call, and two git processes cost more than
 * the rest of the hook. Walking up from `cwd`, a `.git` directory is a main
 * checkout; a `.git` file is a linked worktree (or a submodule) naming its
 * gitdir, whose `commondir` file names the shared directory. The common
 * directory is resolved through symlinks, so every agent computes the same
 * path for it.
 *
 * @param cwd - any directory.
 * @returns the directories, or undefined when `cwd` is in no repository or
 *   its `.git` file cannot be read.
 */
export function findGitDirs(cwd: string): GitDirs | undefined {
  let dir = resolve(cwd);
  let previous: string | undefined;
  while (dir !== previous) {
    const dotGit = join(dir, ".git");
    const stat = statSync(dotGit, { throwIfNoEntry: false });
    if (stat?.isDirectory())
      return { worktree: dir, commonDir: realpathSync(dotGit) };
    if (stat?.isFile()) {
      const pointer = /^gitdir:[ \t]*(\S.*?)[ \t\r]*$/m.exec(
        readFileSync(dotGit, "utf8"),
      );
      if (pointer === null) return undefined;
      const gitdir = resolve(dir, pointer[1] as string);
      let common = gitdir;
      try {
        common = resolve(
          gitdir,
          readFileSync(join(gitdir, "commondir"), "utf8").trim(),
        );
      } catch {
        // No commondir: a submodule, whose gitdir is its own common directory.
      }
      try {
        return { worktree: dir, commonDir: realpathSync(common) };
      } catch {
        return undefined;
      }
    }
    previous = dir;
    dir = dirname(dir);
  }
  return undefined;
}

// Variables that move the git directory somewhere `.git` does not say.
const GIT_DIR_VARIABLES = ["GIT_DIR", "GIT_COMMON_DIR"];

/**
 * The memory directory for the repository `cwd` belongs to: the same path from
 * the main checkout, from any linked worktree and from any subdirectory.
 *
 * @param cwd - any directory inside the repository.
 * @param git - runs git instead of reading `.git`; also used when GIT_DIR or
 *   GIT_COMMON_DIR is set.
 * @param env - the environment.
 * @returns `<git common dir>/antibody`, absolute.
 * @throws NotInGitRepoError when `cwd` is not inside a repository.
 */
export function memoryDir(
  cwd: string,
  git?: GitRunner,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (git === undefined && !GIT_DIR_VARIABLES.some((v) => env[v])) {
    const found = findGitDirs(cwd);
    if (found === undefined) throw new NotInGitRepoError(cwd);
    return join(found.commonDir, MEMORY_DIR_NAME);
  }
  let common: string;
  try {
    common = (git ?? runGit)(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd,
    );
  } catch {
    throw new NotInGitRepoError(cwd);
  }
  if (common === "") throw new NotInGitRepoError(cwd);
  return join(resolve(cwd, common), MEMORY_DIR_NAME);
}
