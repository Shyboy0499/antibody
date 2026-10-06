import { describe, expect, it } from "vitest";
import type { ClaimsState } from "../src/claims";
import type { MemoryEvent } from "../src/events";
import type { Entry } from "../src/store";
import {
  ACTIVE_WINDOW_MS,
  IMMUNE_MS,
  eventLine,
  fleetView,
} from "../src/watch-model";

const NOW = new Date("2026-10-05T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const event = (
  agent: string,
  kind: MemoryEvent["kind"],
  msAgo: number,
  extra: Partial<MemoryEvent> = {},
): MemoryEvent => ({
  v: 1,
  t: ago(msAgo),
  kind,
  agent,
  session: `s-${agent}`,
  ...extra,
});
const entry = (id: string, fingerprint: string, fix = ""): Entry => ({
  id,
  title: `[tool:Bash] error ${id}`,
  meta: { sig: fingerprint },
  fingerprint,
  category: "command-exit / Bash",
  firstSeen: "2026-10-05",
  lastSeen: "2026-10-05",
  hits: 1,
  trigger: "",
  raw: "",
  fix,
  status: fix === "" ? "open" : "fixed",
  notes: "",
});
const claims = (
  ...list: { id: string; agent: string; msAgo: number; expiresIn?: number }[]
): ClaimsState => ({
  version: 1,
  claims: Object.fromEntries(
    list.map((c) => [
      c.id,
      {
        id: c.id,
        agent: c.agent,
        session: `s-${c.agent}`,
        since: ago(c.msAgo),
        expires: new Date(
          NOW.getTime() + (c.expiresIn ?? 60_000),
        ).toISOString(),
      },
    ]),
  ),
});
const none = claims();

describe("fleetView: the fleet pane", () => {
  it("shows who is diagnosing, holding, immune and working", () => {
    const entries = [
      entry("E-0001", "aaaa"),
      entry("E-0002", "bbbb", "Run X."),
    ];
    const events = [
      event("claude-code@wt-a", "miss", 90_000, { id: "E-0001" }),
      event("claude-code@wt-a", "claim", 90_000, { id: "E-0001" }),
      event("gemini@wt-b", "hold", 60_000, {
        id: "E-0001",
        text: "held by claude-code@wt-a",
      }),
      event("codex@wt-c", "notice", 30_000, {
        id: "E-0002",
        notice: "hit",
        tokens: 60,
      }),
      event("claude-code@wt-d", "hit", 20_000, { id: "E-0002" }),
    ];
    const view = fleetView(
      events,
      entries,
      claims({ id: "aaaa", agent: "claude-code@wt-a", msAgo: 90_000 }),
      NOW,
    );
    expect(view.agents).toEqual([
      {
        agent: "claude-code@wt-a",
        state: "diagnosing",
        id: "E-0001",
        since: ago(90_000),
        lastSeen: ago(90_000),
      },
      { agent: "claude-code@wt-d", state: "working", lastSeen: ago(20_000) },
      {
        agent: "codex@wt-c",
        state: "immune",
        id: "E-0002",
        saved: 740,
        lastSeen: ago(30_000),
      },
      {
        agent: "gemini@wt-b",
        state: "holding",
        id: "E-0001",
        holder: "claude-code@wt-a",
        lastSeen: ago(60_000),
      },
    ]);
  });

  it("names a claimed error that has no entry yet", () => {
    const view = fleetView(
      [event("a", "hold", 1_000, { id: "new cccc" })],
      [],
      claims({ id: "cccc", agent: "a", msAgo: 1_000 }),
      NOW,
    );
    expect(view.agents[0]).toMatchObject({
      state: "diagnosing",
      id: "new cccc",
    });
  });

  it("stops holding once the claim lapses or the fix arrives", () => {
    const entries = [entry("E-0001", "aaaa")];
    const held = [event("b", "hold", 10_000, { id: "E-0001" })];
    expect(fleetView(held, entries, none, NOW).agents[0]?.state).toBe(
      "working",
    );
    const fixed = [
      ...held,
      event("b", "notice", 5_000, { id: "E-0001", notice: "hit", tokens: 900 }),
    ];
    expect(
      fleetView(
        fixed,
        entries,
        claims({ id: "aaaa", agent: "a", msAgo: 20_000 }),
        NOW,
      ).agents.find((r) => r.agent === "b"),
    ).toMatchObject({ state: "immune", saved: 0 });
  });

  it("forgets immunity after a while, and agents after longer", () => {
    const events = [
      event("a", "notice", IMMUNE_MS + 1_000, { id: "E-0001", notice: "near" }),
      event("b", "hit", ACTIVE_WINDOW_MS + 1_000),
    ];
    const view = fleetView(events, [], none, NOW);
    expect(view.agents).toEqual([
      { agent: "a", state: "working", lastSeen: ago(IMMUNE_MS + 1_000) },
    ]);
  });
});

describe("fleetView: memory and antibodies", () => {
  it("counts what the fleet saved, and each antibody's reuse", () => {
    const entries = [
      entry("E-0001", "aaaa", "Copy .env."),
      entry("E-0002", "bbbb"),
      entry("E-0003", "cccc"),
    ];
    const events = [
      event("a", "miss", 50_000, { id: "E-0001" }),
      event("a", "fix", 40_000, { id: "E-0001", text: "Copy .env." }),
      event("b", "hit", 30_000, { id: "E-0001" }),
      event("b", "notice", 30_000, {
        id: "E-0001",
        notice: "hit",
        tokens: 100,
      }),
      event("c", "hit", 20_000, { id: "E-0001" }),
      event("c", "notice", 20_000, {
        id: "E-0001",
        notice: "doubted",
        tokens: 120,
      }),
      event("d", "notice", 10_000, {
        id: "E-0002",
        notice: "no-fix",
        tokens: 30,
      }),
    ];
    const view = fleetView(
      events,
      entries,
      claims({ id: "bbbb", agent: "d", msAgo: 10_000 }),
      NOW,
    );
    expect(view.memory).toEqual({
      tokensSaved: 1600 - 250,
      noticeTokens: 250,
      avoided: 2,
      antibodies: 1,
      measured: 0,
      entries: 3,
      open: 2,
      immunity: 1,
      held: 0,
    });
    expect(view.antibodies).toEqual([
      {
        id: "E-0001",
        fingerprint: "aaaa",
        category: "command-exit / Bash",
        title: "[tool:Bash] error E-0001",
        status: "fixed",
        fix: "Copy .env.",
        beatenBy: "a",
        reused: 2,
        saved: 1600 - 220,
      },
      expect.objectContaining({
        id: "E-0002",
        diagnosing: "d",
        reused: 0,
        saved: 0,
      }),
      expect.objectContaining({ id: "E-0003", fix: "", reused: 0 }),
    ]);
    expect(view.antibodies[2]).not.toHaveProperty("diagnosing");
  });

  it("keeps what waits for review out of the antibodies, and counts it", () => {
    const held = {
      ...entry("E-0001", "aaaa", "Copy .env."),
      title: `[tool] hidden\u202e text${String.fromCodePoint(0xe0041)}`,
      meta: { sig: "aaaa", review: "fix+text" },
    };
    const entries = [held, entry("E-0002", "bbbb", "Run X.")];
    const view = fleetView(
      [],
      entries,
      claims({ id: "aaaa", agent: "a", msAgo: 1_000 }),
      NOW,
    );
    expect(view.memory).toMatchObject({ antibodies: 1, held: 1, open: 0 });
    expect(view.antibodies[0]).toMatchObject({
      id: "E-0001",
      title: "[tool] hidden text",
      fix: "",
      held: true,
    });
    // Waiting for review comes before who is diagnosing it.
    expect(view.antibodies[0]).not.toHaveProperty("diagnosing");
    expect(view.antibodies[1]).not.toHaveProperty("held");
    expect(view.antibodies[1]?.fix).toBe("Run X.");
  });

  it("counts a diagnosis at what it was measured to cost", () => {
    const entries = [
      entry("E-0001", "aaaa", "Copy .env."),
      entry("E-0002", "bbbb", "Run X."),
    ];
    const events = [
      event("a", "fix", 50_000, { id: "E-0001", tokens: 3_000 }),
      event("b", "notice", 40_000, {
        id: "E-0001",
        notice: "hit",
        tokens: 100,
      }),
      event("c", "notice", 30_000, { id: "E-0002", notice: "hit", tokens: 50 }),
    ];
    const view = fleetView(events, entries, none, NOW);
    // E-0001 measured at 3,000 and E-0002 assumed at 800, less 150 of notices.
    expect(view.memory).toMatchObject({
      tokensSaved: 3_000 + 800 - 150,
      antibodies: 2,
      measured: 1,
    });
    expect(view.antibodies.map((a) => a.saved)).toEqual([2_900, 750]);
    expect(view.agents.find((a) => a.agent === "b")).toMatchObject({
      state: "immune",
      saved: 2_900,
    });
  });

  it("reads an empty memory as zeros", () => {
    expect(fleetView([], [], none, NOW)).toEqual({
      agents: [],
      memory: {
        tokensSaved: 0,
        noticeTokens: 0,
        avoided: 0,
        antibodies: 0,
        measured: 0,
        entries: 0,
        open: 0,
        immunity: 0,
        held: 0,
      },
      antibodies: [],
      events: [],
    });
  });

  it("keeps the latest events only", () => {
    const events = Array.from({ length: 250 }, (_, i) =>
      event("a", "hit", 250 - i, { id: `E-${i}` }),
    );
    const lines = fleetView(events, [], none, NOW).events;
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)?.id).toBe("E-249");
  });
});

describe("eventLine", () => {
  it.each([
    ["miss", {}, "new", "ENOENT at x"],
    ["hit", {}, "again", "ENOENT at x"],
    ["claim", {}, "claimed", "diagnosing it"],
    ["hold", { text: "held by a" }, "holding", "held by a"],
    ["fix", { text: "Copy .env." }, "antibody", "Copy .env."],
    [
      "notice",
      { notice: "hit", tokens: 90 },
      "immune",
      "fix pushed (90 tokens)",
    ],
    ["notice", { notice: "near" }, "immune", "fix pushed (0 tokens)"],
    [
      "notice",
      { notice: "no-fix", text: "seen before" },
      "notice",
      "seen before",
    ],
    ["release", {}, "released", "claim released"],
    ["release", { text: "fix recorded" }, "released", "fix recorded"],
    ["resolve", {}, "resolved", "the call succeeded again"],
    ["forget", {}, "forgotten", "archived"],
    ["forget", { text: "typo" }, "forgotten", "typo"],
  ] as const)("reads %s %j as %s", (kind, extra, tag, text) => {
    const base =
      kind === "miss" || kind === "hit" ? { text: "ENOENT\n  at x" } : {};
    expect(
      eventLine(event("a", kind, 0, { id: "E-0001", ...base, ...extra })),
    ).toEqual({ t: ago(0), agent: "a", id: "E-0001", tag, text });
  });

  it("leaves out a missing id", () => {
    expect(eventLine(event("a", "claim", 0))).not.toHaveProperty("id");
  });
});
