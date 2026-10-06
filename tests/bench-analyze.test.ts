import { describe, expect, it } from "vitest";
import {
  median,
  renderResults,
  summariseArms,
  summariseRun,
  trapOutcomes,
} from "../bench/analyze";
import type { AgentResult, RunSummary } from "../bench/analyze";
import type { MemoryEvent } from "../src/events";
import type { Entry } from "../src/store";

const entry = (id: string, title: string): Entry => ({
  id,
  title,
  meta: { sig: id },
  fingerprint: id,
  category: "command-exit / Bash",
  firstSeen: "2026-10-06",
  lastSeen: "2026-10-06",
  hits: 1,
  trigger: "npm test",
  raw: title,
  fix: "",
  status: "open",
  notes: "",
});
const ENTRIES = [
  entry(
    "E-0001",
    'npm test → ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"',
  ),
  entry("E-0002", "Error: Environment variable not found: DATABASE_URL."),
  entry(
    "E-0003",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/w/generated/client.js'",
  ),
  entry("E-0004", "Error: listen EADDRINUSE: address already in use :::4817"),
  entry("E-0005", "TypeError: slugify is not a function"),
];

let clock = 0;
const event = (
  agent: string,
  kind: MemoryEvent["kind"],
  id: string,
  extra: Partial<MemoryEvent> = {},
): MemoryEvent => ({
  v: 1,
  t: new Date(Date.UTC(2026, 9, 6, 10, 0, clock++)).toISOString(),
  kind,
  agent,
  session: `s-${agent}`,
  id,
  ...extra,
});

describe("trapOutcomes", () => {
  it("counts who met each trap, who a fix reached in time, and who diagnosed it", () => {
    clock = 0;
    const events = [
      // The lockfile: a meets it first and diagnoses it; b is given the fix
      // before it gets past; c gets past on its own before the fix reaches it.
      event("a", "miss", "E-0001"),
      event("b", "hit", "E-0001"),
      event("c", "hit", "E-0001"),
      event("b", "notice", "E-0001", { notice: "hit", tokens: 90 }),
      event("c", "resolve", "E-0001"),
      event("c", "notice", "E-0001", { notice: "hit", tokens: 90 }),
      // The .env: only a meets it, and a notice without a fix helps nobody.
      event("a", "miss", "E-0002"),
      event("b", "notice", "E-0002", { notice: "no-fix", tokens: 20 }),
      // The port: two agents, nobody helped.
      event("a", "miss", "E-0004"),
      event("b", "hit", "E-0004"),
      event("b", "hit", "E-0004"),
      // The agents' own mistakes are not traps.
      event("c", "miss", "E-0005"),
      { ...event("c", "hit", "E-0005"), id: undefined },
    ];
    expect(trapOutcomes(events, ENTRIES)).toEqual([
      { trap: "lockfile", met: 3, helped: 1, diagnosed: 2 },
      { trap: "env", met: 1, helped: 0, diagnosed: 1 },
      { trap: "generated", met: 0, helped: 0, diagnosed: 0 },
      { trap: "port", met: 2, helped: 0, diagnosed: 2 },
    ]);
  });
});

const agent = (
  name: string,
  tokens: number | undefined,
  durationMs: number,
  done = true,
): AgentResult => ({
  agent: name,
  task: "slugify",
  ...(tokens === undefined ? {} : { tokens }),
  durationMs,
  done,
});

describe("trapOutcomes: entries as antibody stores them", () => {
  it("knows the generated client from its redacted path", () => {
    clock = 0;
    const stored = entry(
      "E-0009",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<path>/client.js' imported from <path>/db.js",
    );
    const outcomes = trapOutcomes([event("a", "miss", "E-0009")], [stored]);
    expect(outcomes.find((o) => o.trap === "generated")?.met).toBe(1);
  });
});

describe("summariseRun", () => {
  it("adds the diagnoses up, and counts beyond the first of each trap as repeats", () => {
    clock = 0;
    const events = [
      event("a", "miss", "E-0001"),
      event("b", "hit", "E-0001"),
      event("c", "hit", "E-0001"),
      event("a", "miss", "E-0002"),
      event("b", "hit", "E-0002"),
      event("b", "notice", "E-0002", { notice: "hit", tokens: 80 }),
      event("c", "notice", "E-0001", { notice: "hold", tokens: 40 }),
    ];
    const agents = [agent("a", 1000, 5000)];
    expect(summariseRun("on", agents, events, ENTRIES)).toMatchObject({
      arm: "on",
      agents,
      diagnoses: 4,
      repeatDiagnoses: 2,
      fixNotices: 1,
      noticeTokens: 120,
    });
  });
});

describe("median", () => {
  it("takes the middle, or the mean of the two middles", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

const run = (
  arm: "on" | "off",
  agents: AgentResult[],
  repeatDiagnoses: number,
): RunSummary => ({
  arm,
  agents,
  traps: [],
  diagnoses: repeatDiagnoses + 4,
  repeatDiagnoses,
  fixNotices: 0,
  noticeTokens: 0,
});

describe("summariseArms and renderResults", () => {
  const runs = [
    run("off", [agent("a", 9000, 60_000), agent("b", 11_000, 80_000)], 6),
    run("on", [agent("a", 6000, 40_000), agent("b", 6000, 45_000, false)], 1),
    run("off", [agent("a", 10_000, 70_000), agent("b", 12_000, 90_000)], 8),
    run("on", [agent("a", 7000, 50_000), agent("b", undefined, 55_000)], 3),
  ];

  it("takes each arm's median run, and the share of tasks done", () => {
    expect(summariseArms(runs)).toEqual([
      {
        arm: "on",
        runs: 2,
        tokens: 12_000,
        wallMs: 50_000,
        diagnoses: 6,
        repeatDiagnoses: 2,
        done: 3,
        given: 4,
        unmeasured: 1,
      },
      {
        arm: "off",
        runs: 2,
        tokens: 21_000,
        wallMs: 85_000,
        diagnoses: 11,
        repeatDiagnoses: 7,
        done: 4,
        given: 4,
        unmeasured: 0,
      },
    ]);
    expect(summariseArms(runs.filter((r) => r.arm === "off"))).toHaveLength(1);
  });

  it("writes a Markdown table, with what injection changed", () => {
    expect(renderResults(summariseArms(runs), "2 scripted agents")).toBe(
      [
        "Benchmark: 2 scripted agents. Medians per run.",
        "",
        "| Injection | Runs | Tokens | Fleet wall time | Trap diagnoses | Repeat diagnoses | Tasks done |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        "| on | 2 | 12,000 | 50 s | 6 | 2 | 3 / 4 |",
        "| off | 2 | 21,000 | 85 s | 11 | 7 | 4 / 4 |",
        "",
        "With injection on: 43% fewer tokens, 41% less wall time, 5 fewer repeat diagnoses per run.",
        "",
        "Tokens leave out 1 run where an agent's transcript could not be read.",
        "",
      ].join("\n"),
    );
  });

  it("writes one arm alone, and dashes for what it could not measure", () => {
    const text = renderResults(
      summariseArms([run("on", [agent("a", undefined, 4200)], 0)]),
      "1 agent",
    );
    expect(text).toContain("| on | 1 | - | 4.2 s | 4 | 0 | 1 / 1 |");
    expect(text).not.toContain("With injection on");
    expect(renderResults([], "nothing")).toContain("| --- |");
  });
});
