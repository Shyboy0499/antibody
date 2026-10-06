// The benchmark's project does what bench/traps.ts and bench/tasks.ts say:
// a fresh worktree meets the four traps one at a time, each documented fix
// clears its trap, and each hidden check fails before its task is done and
// passes with the reference solution.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_DIR, TASKS, checkFile, solutionDir } from "../bench/tasks";
import { BENCH_PORT, TRAPS, trapOf } from "../bench/traps";

let root: string;
let worktree: string;
let blocker: Server;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-bench-")));
  const repo = join(root, "shop");
  cpSync(FIXTURE_DIR, repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      { cwd: repo, stdio: "ignore" },
    );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  worktree = join(root, "wt-a");
  git("worktree", "add", "-q", "-b", "a", worktree);
  // What the benchmark's runner does: another process has the default port.
  blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(BENCH_PORT, resolve));
});

afterAll(() => {
  blocker.close();
  rmSync(root, { recursive: true, force: true });
});

/** `npm test` in the worktree, as an agent would run it. */
const npmTest = () => {
  const run = spawnSync("npm", ["test"], {
    cwd: worktree,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
  });
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
};

describe("the benchmark's setup traps", () => {
  it("meets each trap in turn, alone, until its fix is applied", () => {
    for (const trap of TRAPS) {
      const { ok, output } = npmTest();
      expect(ok, trap.id).toBe(false);
      // This trap, and no later one, shows.
      expect(trapOf(output)?.id, trap.id).toBe(trap.id);
      for (const later of TRAPS.slice(TRAPS.indexOf(trap) + 1))
        expect(later.pattern.test(output), `${trap.id} hides ${later.id}`).toBe(
          false,
        );
      trap.apply(worktree);
    }
    const { ok, output } = npmTest();
    expect(ok, output).toBe(true);
  }, 60_000);
});

describe("the benchmark's tasks", () => {
  // The checks run as the runner runs them: in the worktree, traps fixed.
  const check = (task: (typeof TASKS)[number]) =>
    spawnSync(process.execPath, ["--test", checkFile(task)], {
      cwd: worktree,
      encoding: "utf8",
    }).status === 0;

  it("has eight, each with a check that the base project fails", () => {
    expect(TASKS).toHaveLength(8);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(8);
    for (const task of TASKS) expect(check(task), task.id).toBe(false);
  }, 60_000);

  it("passes each check with the task's reference solution", () => {
    for (const task of TASKS) {
      for (const file of task.solution)
        cpSync(join(solutionDir(task), file), join(worktree, file));
      expect(check(task), task.id).toBe(true);
      // The project's own tests still pass with the solution in place.
      expect(npmTest().ok, task.id).toBe(true);
      execFileSync("git", ["checkout", "--", ...task.solution], {
        cwd: worktree,
      });
    }
  }, 120_000);
});
