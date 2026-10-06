// What a benchmark run shows, read from the memory antibody kept during it.
//
// The hooks record every failure in both arms - with injection off they only
// stay silent - so the event log says, for each agent and each trap, whether
// the agent met it and whether a fix reached it in time. An agent that met a
// trap and got no fix before it got past the error diagnosed it itself. The
// first diagnosis of a trap has to happen; every one after it is the waste
// antibody exists to remove (docs/design.md §2).
import type { MemoryEvent } from "../src/events";
import { FIX_NOTICE_KINDS } from "../src/notice";
import type { NoticeKind } from "../src/notice";
import type { Entry } from "../src/store";
import { TRAPS, trapOf } from "./traps";
import type { Trap } from "./traps";

/** The two arms: the same fleet with injection on, and with it off. */
export const ARMS = ["on", "off"] as const;
export type Arm = (typeof ARMS)[number];

/** How one trap went in a run. */
export interface TrapOutcome {
  trap: Trap["id"];
  /** Agents that met it. */
  met: number;
  /** Agents a fix reached before they got past it. */
  helped: number;
  /** Agents that got past it on their own. */
  diagnosed: number;
}

/** One agent's part in a run. */
export interface AgentResult {
  agent: string;
  task: string;
  /** Tokens newly read or written, from its transcript, when known. */
  tokens?: number;
  /** From start to exit, in milliseconds. */
  durationMs: number;
  /** Whether its task's hidden check passed. */
  done: boolean;
}

/** One run of one arm. */
export interface RunSummary {
  arm: Arm;
  agents: AgentResult[];
  traps: TrapOutcome[];
  /** Diagnoses of the traps, and those beyond the first of each. */
  diagnoses: number;
  repeatDiagnoses: number;
  /** Notices that carried a fix, and what every notice cost. */
  fixNotices: number;
  noticeTokens: number;
}

const isFixNotice = (e: MemoryEvent) =>
  e.kind === "notice" && FIX_NOTICE_KINDS.includes(e.notice as NoticeKind);

/**
 * How each trap went: who met it, who a fix reached in time, and who
 * diagnosed it. A fix counts only when it reached the agent before the agent
 * got past the error on its own (its `resolve` event for the entry).
 *
 * @param events - the run's events.jsonl, oldest first.
 * @param entries - the run's ANTIBODIES.md entries, to tell the traps apart.
 */
export function trapOutcomes(
  events: readonly MemoryEvent[],
  entries: readonly Entry[],
): TrapOutcome[] {
  // Events name an entry by its ID, or, while an error is too new to have
  // one, as "new error <fingerprint>": a peer told to hold met it all the same.
  const trapOfEntry = new Map<string, Trap["id"]>();
  for (const entry of entries) {
    const trap = trapOf(`${entry.title}\n${entry.raw}`);
    if (trap === undefined) continue;
    trapOfEntry.set(entry.id, trap.id);
    trapOfEntry.set(
      `new error ${entry.meta.sig ?? entry.fingerprint}`,
      trap.id,
    );
  }
  // Per trap and agent: when it met it, got a fix, and got past it.
  const met = new Map<string, Set<string>>();
  const fixedAt = new Map<string, number>();
  const resolvedAt = new Map<string, number>();
  const key = (trap: string, agent: string) => `${trap}\0${agent}`;
  for (const e of events) {
    const trap = e.id === undefined ? undefined : trapOfEntry.get(e.id);
    if (trap === undefined) continue;
    const k = key(trap, e.agent);
    const t = Date.parse(e.t);
    if (e.kind === "hit" || e.kind === "miss" || e.kind === "hold") {
      const agents = met.get(trap) ?? new Set<string>();
      agents.add(e.agent);
      met.set(trap, agents);
    } else if (isFixNotice(e) && !fixedAt.has(k)) fixedAt.set(k, t);
    else if (e.kind === "resolve" && !resolvedAt.has(k)) resolvedAt.set(k, t);
  }
  return TRAPS.map((trap) => {
    const agents = [...(met.get(trap.id) ?? [])];
    const helped = agents.filter((agent) => {
      const fix = fixedAt.get(key(trap.id, agent));
      const past = resolvedAt.get(key(trap.id, agent));
      return fix !== undefined && (past === undefined || fix <= past);
    }).length;
    return {
      trap: trap.id,
      met: agents.length,
      helped,
      diagnosed: agents.length - helped,
    };
  });
}

/**
 * Summarise one run.
 *
 * @param arm - injection on or off.
 * @param agents - each agent's tokens, time and result.
 * @param events - the run's events.jsonl.
 * @param entries - the run's entries.
 */
export function summariseRun(
  arm: Arm,
  agents: AgentResult[],
  events: readonly MemoryEvent[],
  entries: readonly Entry[],
): RunSummary {
  const traps = trapOutcomes(events, entries);
  const notices = events.filter((e) => e.kind === "notice");
  return {
    arm,
    agents,
    traps,
    diagnoses: traps.reduce((sum, t) => sum + t.diagnosed, 0),
    repeatDiagnoses: traps.reduce(
      (sum, t) => sum + Math.max(0, t.diagnosed - 1),
      0,
    ),
    fixNotices: notices.filter(isFixNotice).length,
    noticeTokens: notices.reduce((sum, e) => sum + (e.tokens ?? 0), 0),
  };
}

/** The median of some numbers; NaN for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** One arm across its runs. */
export interface ArmSummary {
  arm: Arm;
  runs: number;
  /** Medians per run. */
  tokens: number;
  wallMs: number;
  diagnoses: number;
  repeatDiagnoses: number;
  /** Tasks done, over tasks given, across the runs. */
  done: number;
  given: number;
  /** Runs where some agent's tokens could not be measured. */
  unmeasured: number;
}

/** The fleet's tokens in a run, or undefined when an agent's are unknown. */
const runTokens = (run: RunSummary) =>
  run.agents.every((a) => a.tokens !== undefined)
    ? run.agents.reduce((sum, a) => sum + (a.tokens as number), 0)
    : undefined;

/**
 * Each arm across its runs: the median run's tokens, wall time and
 * diagnoses, and the share of tasks done.
 *
 * @param runs - every run, in any order.
 */
export function summariseArms(runs: readonly RunSummary[]): ArmSummary[] {
  return ARMS.filter((arm) => runs.some((r) => r.arm === arm)).map((arm) => {
    const mine = runs.filter((r) => r.arm === arm);
    const measured = mine
      .map(runTokens)
      .filter((t): t is number => t !== undefined);
    return {
      arm,
      runs: mine.length,
      tokens: median(measured),
      // The fleet is done when its slowest agent is.
      wallMs: median(
        mine.map((r) => Math.max(0, ...r.agents.map((a) => a.durationMs))),
      ),
      diagnoses: median(mine.map((r) => r.diagnoses)),
      repeatDiagnoses: median(mine.map((r) => r.repeatDiagnoses)),
      done: mine.reduce(
        (sum, r) => sum + r.agents.filter((a) => a.done).length,
        0,
      ),
      given: mine.reduce((sum, r) => sum + r.agents.length, 0),
      unmeasured: mine.length - measured.length,
    };
  });
}

const thousands = (n: number) =>
  Number.isNaN(n) ? "-" : Math.round(n).toLocaleString("en-US");
const seconds = (ms: number) =>
  Number.isNaN(ms) ? "-" : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
// How the on arm compares with the off arm, in words that go either way:
// "43% fewer tokens", or "11% more wall time" when injection cost time.
const change = (off: number, on: number, fewer: string, more: string) => {
  if (Number.isNaN(off) || Number.isNaN(on) || off === 0) return `- ${fewer}`;
  const share = Math.round((Math.abs(off - on) / off) * 100);
  return `${share}% ${on <= off ? fewer : more}`;
};

/**
 * The results as a Markdown table, with what injection changed when both arms
 * ran.
 *
 * @param arms - from summariseArms().
 * @param label - what ran, such as "8 Claude Code agents".
 */
export function renderResults(
  arms: readonly ArmSummary[],
  label: string,
): string {
  const lines = [
    `Benchmark: ${label}. Medians per run.`,
    "",
    "| Injection | Runs | Tokens | Fleet wall time | Trap diagnoses | Repeat diagnoses | Tasks done |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...arms.map(
      (a) =>
        `| ${a.arm} | ${a.runs} | ${thousands(a.tokens)} | ${seconds(a.wallMs)} | ${thousands(a.diagnoses)} | ${thousands(a.repeatDiagnoses)} | ${a.done} / ${a.given} |`,
    ),
  ];
  const on = arms.find((a) => a.arm === "on");
  const off = arms.find((a) => a.arm === "off");
  if (on !== undefined && off !== undefined) {
    lines.push(
      "",
      `With injection on: ${change(off.tokens, on.tokens, "fewer tokens", "more tokens")}, ${change(off.wallMs, on.wallMs, "less wall time", "more wall time")}, ${thousands(Math.abs(off.repeatDiagnoses - on.repeatDiagnoses))} ${on.repeatDiagnoses <= off.repeatDiagnoses ? "fewer" : "more"} repeat diagnoses per run.`,
    );
  }
  const unmeasured = arms.reduce((sum, a) => sum + a.unmeasured, 0);
  if (unmeasured > 0)
    lines.push(
      "",
      `Tokens leave out ${unmeasured} ${unmeasured === 1 ? "run" : "runs"} where an agent's transcript could not be read.`,
    );
  return `${lines.join("\n")}\n`;
}
