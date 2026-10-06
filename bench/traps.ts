// The setup traps the benchmark's project sets, from the design's table of
// errors a fleet hits (docs/design.md §2). Every fresh worktree meets all four,
// one at a time, before its tests can pass, and each has to be fixed in that
// worktree: knowing the fix is what one agent can give the others.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The port the project's server defaults to, which the runner keeps busy. */
export const BENCH_PORT = 4817;

/** One trap. */
export interface Trap {
  id: "lockfile" | "env" | "generated" | "port";
  /** Its row in the design's table. */
  label: string;
  /** Recognises its error, in a test run's output or in a memory entry. */
  pattern: RegExp;
  /** The fix, in a sentence. */
  fix: string;
  /** Applies the fix in a worktree: the scripted agent's knowledge. */
  apply(worktree: string): void;
}

const node = (worktree: string, script: string) =>
  execFileSync(process.execPath, [script], { cwd: worktree, stdio: "ignore" });

/** The traps, in the order a fresh worktree meets them. */
export const TRAPS: readonly Trap[] = [
  {
    id: "lockfile",
    label: "ERR_PNPM_OUTDATED_LOCKFILE",
    pattern: /ERR_PNPM_OUTDATED_LOCKFILE/,
    fix: "Refresh the lockfile with `npm run lock`.",
    apply: (wt) => node(wt, "scripts/lock.js"),
  },
  {
    id: "env",
    label: "Environment variable not found: DATABASE_URL",
    pattern: /Environment variable not found: DATABASE_URL/,
    fix: "Copy .env.example to .env: worktrees do not get untracked files.",
    apply: (wt) => copyFileSync(join(wt, ".env.example"), join(wt, ".env")),
  },
  {
    id: "generated",
    label: "Cannot find module './generated/client'",
    // Redaction stores the path as <path>/client.js, so the directory is
    // optional.
    pattern: /Cannot find module '[^']*client\.js'/,
    fix: "Generate the client with `npm run generate`: generated/ is not committed.",
    apply: (wt) => node(wt, "scripts/generate.js"),
  },
  {
    id: "port",
    label: "listen EADDRINUSE :::<port>",
    pattern: /EADDRINUSE/,
    fix: `Set PORT=0 in .env, so the server takes a free port instead of ${BENCH_PORT}.`,
    apply: (wt) => {
      const env = join(wt, ".env");
      writeFileSync(
        env,
        readFileSync(env, "utf8").replace(/^PORT=.*$/m, "PORT=0"),
      );
    },
  },
];

/** The trap an error belongs to, if it is one of them. */
export function trapOf(text: string): Trap | undefined {
  return TRAPS.find((trap) => trap.pattern.test(text));
}
