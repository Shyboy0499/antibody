// How the runner starts one agent on one task, per kind of agent. A driver
// runs the agent in its worktree until it exits, and says what its tokens
// were; the runner times it and checks its work.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokensBetween } from "../src/transcript";
import type { Arm } from "./analyze";
import { runFakeAgent } from "./fake-agent";
import type { Task } from "./tasks";

/** What a driver is given for one agent. */
export interface AgentContext {
  worktree: string;
  task: Task;
  /** A fresh session id, a UUID. */
  session: string;
  arm: Arm;
  /** A directory of the run's own, for transcripts and logs. */
  runDir: string;
  /** The antibody bundle the agent's hooks call. */
  bundle: string;
  /** When to give up on the agent. */
  timeoutMs: number;
}

/** What a driver reports. */
export interface DriverResult {
  /** Tokens newly read or written, when they could be measured. */
  tokens?: number;
  /** Anything else worth keeping in the run's record. */
  details?: Record<string, unknown>;
}

/** One kind of agent. */
export interface Driver {
  /** How the results name the fleet: "8 scripted agents". */
  describe(agents: number): string;
  run(context: AgentContext): Promise<DriverResult>;
  /** What one agent may spend at most, in dollars, for agents that cost. */
  capUsd?: number;
}

/** Settings for the scripted agent, from the runner's options. */
export interface FakeDriverOptions {
  speed: number;
  /** When it records a fix with injection on; with it off, it never does. */
  record: "asked" | "fixed";
  patienceMs?: number;
  /** Run the tests through a pipe, as real agents do (#131). */
  pipe?: boolean;
}

/** The scripted agent of bench/fake-agent.ts. */
export function fakeDriver(options: FakeDriverOptions): Driver {
  return {
    describe: (n) =>
      `${n} scripted ${n === 1 ? "agent" : "agents"} (fixes recorded ${options.record === "asked" ? "when asked" : "once they work"}${options.pipe === true ? ", tests piped" : ""})`,
    async run(context) {
      const transcript = join(context.runDir, `${context.session}.jsonl`);
      const report = await runFakeAgent({
        worktree: context.worktree,
        task: context.task,
        session: context.session,
        transcript,
        bundle: context.bundle,
        speed: options.speed,
        // With injection off nothing asks, and an agent without antibody
        // would not record what it found either.
        record: context.arm === "off" ? "asked" : options.record,
        ...(options.patienceMs === undefined
          ? {}
          : { patienceMs: options.patienceMs }),
        ...(options.pipe === undefined ? {} : { pipe: options.pipe }),
      });
      const tokens = tokensBetween(
        readFileSync(transcript, "utf8"),
        new Date(0),
        new Date(),
      );
      return {
        ...(tokens === undefined ? {} : { tokens }),
        details: { ...report },
      };
    },
  };
}
