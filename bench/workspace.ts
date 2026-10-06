// A benchmark run's workspace: the project in a fresh git repository, one
// worktree per agent, and the project's default port held by someone else.
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { join } from "node:path";
import { FIXTURE_DIR } from "./tasks";
import { BENCH_PORT } from "./traps";

/** A run's repository and its agents' worktrees. */
export interface Workspace {
  repo: string;
  worktrees: string[];
  /** antibody's memory directory for the repository. */
  memory: string;
  /** The port the project defaults to. */
  port: number;
}

/**
 * Copy the project into `root`, commit it, and add a worktree per agent, the
 * way an orchestrator starts a fleet: `wt-1` on branch `agent-1`, and so on.
 *
 * @param root - an empty directory.
 * @param agents - how many worktrees.
 * @param port - the project's default port, which the run keeps busy; tests
 *   that run side by side each take their own.
 */
export function createWorkspace(
  root: string,
  agents: number,
  port: number = BENCH_PORT,
): Workspace {
  const repo = join(root, "shop");
  cpSync(FIXTURE_DIR, repo, { recursive: true });
  if (port !== BENCH_PORT)
    for (const file of [".env.example", join("src", "config.js")]) {
      const path = join(repo, file);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replaceAll(String(BENCH_PORT), String(port)),
      );
    }
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=bench",
        "-c",
        "user.email=bench@example.invalid",
        ...args,
      ],
      { cwd: repo, stdio: "ignore" },
    );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "The shop, as every agent starts from it");
  const worktrees = Array.from({ length: agents }, (_, i) => {
    const worktree = join(root, `wt-${i + 1}`);
    git("worktree", "add", "-q", "-b", `agent-${i + 1}`, worktree);
    return worktree;
  });
  return { repo, worktrees, memory: join(repo, ".git", "antibody"), port };
}

/** Hold a port, as another agent's dev server would, until closed. */
export function holdPort(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}
