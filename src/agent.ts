// Who an event comes from: an agent's display name.
//
// An orchestrator that starts the agents can name each one through
// ANTIBODY_AGENT. Without it, antibody names an agent after its harness and the
// worktree it runs in, `claude-code@agent-a`: agents in different worktrees get
// different names, and one worktree keeps its name across sessions.
import { basename } from "node:path";
import { clip, oneLine } from "./notice";
import { findGitDirs } from "./paths";
import type { GitRunner } from "./paths";

/** The environment variable an orchestrator sets to name an agent. */
export const AGENT_ENV = "ANTIBODY_AGENT";

/** Agent names are clipped to this many characters. */
export const AGENT_NAME_MAX_CHARS = 64;

/**
 * The root of the worktree `cwd` is in, or `cwd` itself outside a repository.
 * It reads `.git` (findGitDirs()) unless a git runner is given.
 *
 * @param cwd - any directory.
 * @param git - runs git instead of reading `.git`.
 */
export function worktreeRoot(cwd: string, git?: GitRunner): string {
  if (git === undefined) return findGitDirs(cwd)?.worktree ?? cwd;
  try {
    return git(["rev-parse", "--show-toplevel"], cwd) || cwd;
  } catch {
    return cwd;
  }
}

/**
 * An agent's display name.
 *
 * @param harness - the harness, e.g. `claude-code`.
 * @param worktree - the worktree root the agent works in.
 * @param env - the environment; ANTIBODY_AGENT wins when it is not blank.
 */
export function agentName(
  harness: string,
  worktree: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const chosen = oneLine(env[AGENT_ENV] ?? "");
  const name =
    chosen !== "" ? chosen : `${harness}@${basename(worktree) || worktree}`;
  return clip(name, AGENT_NAME_MAX_CHARS);
}
