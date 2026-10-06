// The model behind `antibody watch`: the memory's files folded into what the
// fleet view shows. Pure: the caller reads events.jsonl, ANTIBODIES.md and
// claims.json, and passes the time; the renderer only lays this out.
//
// The panes follow demo/index.html:
//
// - fleet: one row per agent seen recently, with what it is doing now -
//   diagnosing an error it claimed, holding for a peer's fix, immune (a fix
//   was just pushed to it), or working;
// - memory: tokens saved, re-diagnoses avoided, antibodies, fleet immunity;
// - antibodies: every entry with its fix, or who is diagnosing it, who beat
//   it, how often its fix was reused and what that saved;
// - events: the latest events, newest last.
import type { ClaimsState } from "./claims";
import { activeClaim } from "./claims";
import type { MemoryEvent } from "./events";
import { plain } from "./exchange";
import { FIX_NOTICE_KINDS, oneLine } from "./notice";
import type { NoticeKind } from "./notice";
import { pendingReview } from "./review";
import type { Entry } from "./store";
import { ASSUMED_DIAGNOSIS_TOKENS } from "./tools";

/** An agent counts as part of the fleet for this long after its last event. */
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

/** A fix pushed to an agent shows it as immune for this long. */
export const IMMUNE_MS = 2 * 60 * 1000;

/** The events pane keeps this many of the latest events. */
export const EVENT_LINES = 200;

/** What an agent is doing, as the fleet pane shows it. */
export type AgentState = "diagnosing" | "holding" | "immune" | "working";

/** One row of the fleet pane. */
export interface AgentRow {
  agent: string;
  state: AgentState;
  /** The entry the state is about, when there is one. */
  id?: string;
  /** diagnosing: since when, ISO 8601. holding: who is on it. */
  since?: string;
  holder?: string;
  /** immune: the tokens the pushed fix is assumed to have saved. */
  saved?: number;
  /** The agent's latest event, ISO 8601. */
  lastSeen: string;
}

/** The memory pane's figures. */
export interface MemoryFigures {
  /** Fix notices × the assumed diagnosis, minus every notice's tokens; ≥ 0. */
  tokensSaved: number;
  noticeTokens: number;
  /** Notices that carried a fix: re-diagnoses avoided. */
  avoided: number;
  /** Entries with a fix, and all entries. */
  antibodies: number;
  entries: number;
  open: number;
  /** Fix notices over hits of entries that had a fix to give, 0 to 1. */
  immunity: number;
  /** Entries holding something back until a person reviews it. */
  held: number;
}

/** One row of the antibodies pane. */
export interface AntibodyRow {
  id: string;
  fingerprint: string;
  category: string;
  title: string;
  status: Entry["status"];
  fix: string;
  /** Its fix or text waits for a person's review: `antibody review`. */
  held?: true;
  /** Who is diagnosing it now, when it has no fix and a live claim. */
  diagnosing?: string;
  /** Who recorded its fix. */
  beatenBy?: string;
  /** Notices that carried its fix. */
  reused: number;
  saved: number;
}

/** How an event reads in the events pane. */
export type EventTag =
  | "new"
  | "again"
  | "claimed"
  | "holding"
  | "antibody"
  | "immune"
  | "notice"
  | "released"
  | "resolved"
  | "forgotten";

/** One line of the events pane. */
export interface EventLine {
  t: string;
  agent: string;
  id?: string;
  tag: EventTag;
  text: string;
}

/** Everything the fleet view shows. */
export interface FleetView {
  agents: AgentRow[];
  memory: MemoryFigures;
  antibodies: AntibodyRow[];
  events: EventLine[];
}

const fixNotice = (e: MemoryEvent) =>
  e.kind === "notice" && FIX_NOTICE_KINDS.includes(e.notice as NoticeKind);

/** How one event reads in the events pane. */
export function eventLine(event: MemoryEvent): EventLine {
  const text = oneLine(event.text ?? "");
  const line = (tag: EventTag, body: string): EventLine => ({
    t: event.t,
    agent: event.agent,
    ...(event.id === undefined ? {} : { id: event.id }),
    tag,
    text: body,
  });
  switch (event.kind) {
    case "miss":
      return line("new", text);
    case "hit":
      return line("again", text);
    case "claim":
      return line("claimed", "diagnosing it");
    case "hold":
      return line("holding", text);
    case "fix":
      return line("antibody", text);
    case "notice":
      return fixNotice(event)
        ? line("immune", `fix pushed (${event.tokens ?? 0} tokens)`)
        : line("notice", text);
    case "release":
      return line("released", text === "" ? "claim released" : text);
    case "resolve":
      return line("resolved", "the call succeeded again");
    case "forget":
      return line("forgotten", text === "" ? "archived" : text);
  }
}

/**
 * Fold the memory into the fleet view.
 *
 * @param events - events.jsonl, oldest first.
 * @param entries - the entries, with this machine's hits added.
 * @param claims - claims.json.
 * @param now - the current time.
 */
export function fleetView(
  events: readonly MemoryEvent[],
  entries: readonly Entry[],
  claims: ClaimsState,
  now: Date,
): FleetView {
  const at = now.getTime();
  const byFingerprint = new Map(entries.map((e) => [e.fingerprint, e]));
  const live = Object.values(claims.claims).filter(
    (c) => activeClaim(claims, c.id, now) !== undefined,
  );
  const entryIdOf = (fingerprint: string) =>
    byFingerprint.get(fingerprint)?.id ?? `new ${fingerprint}`;

  // Per agent, its latest event, and its latest hold and fix notice.
  const latest = new Map<string, MemoryEvent>();
  const lastHold = new Map<string, MemoryEvent>();
  const lastImmune = new Map<string, MemoryEvent>();
  for (const event of events) {
    latest.set(event.agent, event);
    if (event.kind === "hold") lastHold.set(event.agent, event);
    if (fixNotice(event)) lastImmune.set(event.agent, event);
  }

  const agents: AgentRow[] = [];
  for (const [agent, last] of latest) {
    if (at - Date.parse(last.t) > ACTIVE_WINDOW_MS) continue;
    const row: AgentRow = { agent, state: "working", lastSeen: last.t };
    const claim = live.find((c) => c.agent === agent);
    const hold = lastHold.get(agent);
    const immune = lastImmune.get(agent);
    const holdId = hold?.id ?? "";
    const holdEntry = entries.find((e) => e.id === holdId);
    const heldClaim = live.find(
      (c) => holdEntry !== undefined && c.id === holdEntry.fingerprint,
    );
    if (claim !== undefined) {
      Object.assign(row, {
        state: "diagnosing",
        id: entryIdOf(claim.id),
        since: claim.since,
      });
    } else if (
      hold !== undefined &&
      heldClaim !== undefined &&
      (immune === undefined || Date.parse(immune.t) < Date.parse(hold.t))
    ) {
      Object.assign(row, {
        state: "holding",
        id: holdId,
        holder: heldClaim.agent,
      });
    } else if (immune !== undefined && at - Date.parse(immune.t) <= IMMUNE_MS) {
      Object.assign(row, {
        state: "immune",
        ...(immune.id === undefined ? {} : { id: immune.id }),
        saved: Math.max(0, ASSUMED_DIAGNOSIS_TOKENS - (immune.tokens ?? 0)),
      });
    }
    agents.push(row);
  }
  agents.sort((a, b) => a.agent.localeCompare(b.agent));

  const notices = events.filter((e) => e.kind === "notice");
  const noticeTokens = notices.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
  const fixNotices = notices.filter(fixNotice);
  // A fix that waits for review is not an antibody yet.
  const withFix = entries.filter(
    (e) => oneLine(e.fix) !== "" && !pendingReview(e),
  );
  const fixedIds = new Set(withFix.map((e) => e.id));
  const hitsOnFixed = events.filter(
    (e) => e.kind === "hit" && e.id !== undefined && fixedIds.has(e.id),
  ).length;

  // Per entry, in one pass: its fix notices and their tokens, and who
  // recorded its latest fix.
  const reuse = new Map<string, { count: number; tokens: number }>();
  const fixedBy = new Map<string, string>();
  for (const e of events) {
    if (e.id === undefined) continue;
    if (e.kind === "fix") fixedBy.set(e.id, e.agent);
    if (!fixNotice(e)) continue;
    const tally = reuse.get(e.id) ?? { count: 0, tokens: 0 };
    tally.count++;
    tally.tokens += e.tokens ?? 0;
    reuse.set(e.id, tally);
  }
  const claimOf = new Map(live.map((c) => [c.id, c]));

  const antibodies: AntibodyRow[] = entries.map((entry) => {
    const { count, tokens } = reuse.get(entry.id) ?? { count: 0, tokens: 0 };
    const beatenBy = fixedBy.get(entry.id);
    const claim = claimOf.get(entry.fingerprint);
    const held = pendingReview(entry);
    const hasFix = oneLine(entry.fix) !== "" && !held;
    return {
      id: entry.id,
      fingerprint: entry.fingerprint,
      category: plain(entry.category),
      title: plain(entry.title),
      status: entry.status,
      fix: held ? "" : oneLine(entry.fix),
      ...(held ? { held: true as const } : {}),
      ...(!hasFix && !held && claim !== undefined
        ? { diagnosing: claim.agent }
        : {}),
      ...(beatenBy === undefined ? {} : { beatenBy }),
      reused: count,
      saved: Math.max(0, count * ASSUMED_DIAGNOSIS_TOKENS - tokens),
    };
  });

  return {
    agents,
    memory: {
      tokensSaved: Math.max(
        0,
        fixNotices.length * ASSUMED_DIAGNOSIS_TOKENS - noticeTokens,
      ),
      noticeTokens,
      avoided: fixNotices.length,
      antibodies: withFix.length,
      entries: entries.length,
      open: entries.filter((e) => e.status === "open" && oneLine(e.fix) === "")
        .length,
      immunity:
        hitsOnFixed === 0 ? 0 : Math.min(1, fixNotices.length / hitsOnFixed),
      held: entries.filter(pendingReview).length,
    },
    antibodies,
    events: events.slice(-EVENT_LINES).map(eventLine),
  };
}
