// The fleet loop: what antibody does when an agent's tool call fails or
// succeeds, in one step per hook call. It joins what is built so far - capture,
// matching, the store, state, fix trust, notices, the event log and the
// session file - and returns the notices to show the agent.
//
// Every call runs inside the session's lock (src/session.ts), so the hooks of
// parallel tool calls in one session take turns; the store, state and claims
// take the memory directory's lock inside it, always in that order.
//
// Claims are keyed by fingerprint, not entry ID. Whoever claims a new
// fingerprint first is the one that diagnoses it and the only one that appends
// its entry, so two agents meeting a new error at the same moment never write
// two entries for it; the other agent is told a peer is on it and remembers to
// wait for the fix.
//
// Each hook call is its own process. The engine is created per call, restores
// the session's budgets, watches and turn from the session file, and saves them
// back before it returns. Fix-trust records live in state.json, shared by the
// fleet; only the records this call changed are written back.
import { TransientCounter, classify } from "./capture";
import type { CaptureRecord } from "./capture";
import { CLAIM_TTL_MS, activeClaim, createClaimsFile } from "./claims";
import type { ClaimOutcome } from "./claims";
import type { CaptureInput, CaptureOptions } from "./capture";
import { appendEvent } from "./events";
import type { NewEvent } from "./events";
import { Injector } from "./injector";
import { indexEntries, match } from "./match";
import type { Hit, MatchOptions } from "./match";
import { CapTracker, claimHintText, estimateTokens, oneLine } from "./notice";
import type { InjectMode, Notice } from "./notice";
import { filesIn } from "./paths";
import { ResolutionTracker, callOutcome } from "./resolve-detect";
import type { ToolCall } from "./resolve-detect";
import { createSessionFile } from "./session";
import type { SessionState } from "./session";
import { addHit, createStateFile, effectiveEntry, laterSeen } from "./state";
import type { MachineState } from "./state";
import { createStore, formatSeen, nodeStoreFs, systemClock } from "./store";
import type { Entry, StoreClock, StoreFs } from "./store";
import { FixTrust, memoryTrustStore } from "./trust";
import type { TrustRecord } from "./trust";

/** Settings for the fleet loop; every one has a default. */
export interface FleetOptions {
  /** The `inject` setting: `hit-only`, `always` or `off`. */
  inject: InjectMode;
  match: Partial<MatchOptions>;
  capture: Partial<CaptureOptions>;
  /** How long a hook waits for a lock before it gives up. */
  lockTimeoutMs: number;
  /** How long a claim lasts unless its holder renews or releases it. */
  claimTtlMs: number;
}

export const DEFAULT_FLEET_OPTIONS: FleetOptions = {
  inject: "hit-only",
  match: {},
  capture: {},
  lockTimeoutMs: 2_000,
  claimTtlMs: CLAIM_TTL_MS,
};

/** The machine the loop runs on; injected in tests. */
export interface FleetDeps {
  fs?: StoreFs;
  clock?: StoreClock;
}

/** One agent session's view of the fleet's memory. */
export interface Fleet {
  /**
   * A tool call failed.
   *
   * @param capture - the failure, from the harness adapter.
   * @param call - the same call, for resolution detection.
   * @returns the notices to show the agent; often none.
   */
  failure(capture: CaptureInput, call: ToolCall): Promise<string[]>;
  /**
   * Deliver any fix this session has been waiting for since another agent
   * claimed the error. Cheap when there is nothing to wait for.
   *
   * @returns the notices to show the agent; often none.
   */
  poll(): Promise<string[]>;
  /**
   * A tool call succeeded. An entry watched under its command or tool is
   * resolved: its fix gains trust, or, without a fix, the agent is asked once
   * to record it.
   *
   * @param call - the call, from the harness adapter.
   * @returns the notices to show the agent; often none.
   */
  success(call: ToolCall): Promise<string[]>;
  /**
   * The user sent a new prompt: the turn's notice budgets start again, old
   * resolution watches lapse, and held fixes are delivered.
   *
   * @returns the notices to show the agent; often none.
   */
  beginTurn(): Promise<string[]>;
  /**
   * The session ended: release every claim it held, so no other agent waits on
   * it, and forget its state.
   *
   * @returns the fingerprints that were released.
   */
  endSession(): Promise<string[]>;
  /**
   * Record the fix for an entry (the `antibody_record` tool): the entry gets the
   * fix and becomes `fixed`, its claim is released whoever held it, and agents
   * waiting for it receive it on their next hook call.
   *
   * @param id - the entry.
   * @param fix - the fix, in a sentence or two.
   * @returns the updated entry, or undefined when the ID is unknown.
   * @throws RangeError when the fix is blank.
   */
  recordFix(id: string, fix: string): Promise<Entry | undefined>;
}

/** The per-call pieces restored from a session file. */
interface Runtime {
  caps: CapTracker;
  tracker: ResolutionTracker;
  trust: FixTrust;
  injector: Injector;
}

/**
 * Bind the fleet loop to one agent session.
 *
 * @param memory - the memory directory, from memoryDir().
 * @param agent - the agent's display name.
 * @param session - the harness's session id.
 * @param options - settings; anything missing takes its default.
 * @param deps - filesystem and clock; default to the real ones.
 */
export function createFleet(
  memory: string,
  agent: string,
  session: string,
  options: Partial<FleetOptions> = {},
  deps: FleetDeps = {},
): Fleet {
  const o: FleetOptions = { ...DEFAULT_FLEET_OPTIONS, ...options };
  const fs = deps.fs ?? nodeStoreFs();
  const clock = deps.clock ?? systemClock();
  const files = filesIn(memory);
  const lock = { lockTimeoutMs: o.lockTimeoutMs };
  const store = createStore(files, lock, fs, clock);
  const state = createStateFile(files, lock, fs, clock);
  const sessionFile = createSessionFile(memory, session, lock, fs, clock);
  const claims = createClaimsFile(
    files,
    { ...lock, ttlMs: o.claimTtlMs },
    fs,
    clock,
  );

  // A claim granted just now, as opposed to the holder renewing its own.
  const fresh = (outcome: ClaimOutcome) =>
    outcome.granted &&
    Date.parse(outcome.claim.expires) - Date.parse(outcome.claim.since) ===
      o.claimTtlMs;

  const log = (event: Omit<NewEvent, "agent" | "session">) =>
    appendEvent(files.events, { ...event, agent, session }, clock.now());

  async function readEntries(machine: MachineState): Promise<Entry[]> {
    const document = await store.read();
    return document.blocks.map((b) =>
      effectiveEntry(b.entry, machine.entries[b.entry.id]),
    );
  }

  function restore(
    s: SessionState,
    trust: Record<string, TrustRecord>,
  ): Runtime {
    const caps = CapTracker.restore(s.caps);
    const tracker = ResolutionTracker.restore(s.resolution);
    const fixTrust = new FixTrust(memoryTrustStore({ entries: trust }));
    fixTrust.restoreTurn(s.trustTurn, session);
    const injector = new Injector({
      mode: o.inject,
      caps,
      trust: fixTrust,
      scope: session,
    });
    return { caps, tracker, trust: fixTrust, injector };
  }

  // Save the session's part, then write back the trust records this call changed.
  async function persist(
    s: SessionState,
    rt: Runtime,
    before: Record<string, TrustRecord>,
  ): Promise<void> {
    s.caps = rt.caps.snapshot();
    s.resolution = rt.tracker.snapshot();
    s.trustTurn = rt.trust.injectedInTurn(session);
    const after = rt.trust.snapshot().entries;
    const changed = Object.keys(after).filter(
      (id) => JSON.stringify(after[id]) !== JSON.stringify(before[id]),
    );
    if (changed.length > 0)
      await state.update((m) => {
        for (const id of changed) m.trust[id] = after[id] as TrustRecord;
      });
  }

  async function tell(
    notice: Notice | undefined,
    notices: string[],
  ): Promise<void> {
    if (notice === undefined) return;
    notices.push(notice.text);
    await log({
      kind: "notice",
      id: notice.id,
      tokens: estimateTokens(notice.text),
      text: notice.text,
    });
  }

  // Another session holds `fingerprint`: hint once more if the budget allows,
  // and remember to pass the fix on when it is recorded.
  async function hold(
    s: SessionState,
    rt: Runtime,
    fingerprint: string,
    label: string,
    outcome: Extract<ClaimOutcome, { granted: false }>,
    notices: string[],
  ): Promise<void> {
    if (!s.holding.includes(fingerprint)) s.holding.push(fingerprint);
    await log({
      kind: "hold",
      id: label,
      text: `held by ${outcome.holder.agent}`,
    });
    if (!rt.caps.tryEmit(`${fingerprint}\0hold`)) return;
    const elapsed = clock.now().getTime() - Date.parse(outcome.holder.since);
    const text = claimHintText(label, outcome.holder.agent, elapsed);
    notices.push(text);
    await log({
      kind: "notice",
      id: label,
      tokens: estimateTokens(text),
      text,
    });
  }

  // A hit: count it, then offer its fix, or claim it when it has none.
  async function onHit(
    s: SessionState,
    rt: Runtime,
    found: Hit,
    record: CaptureRecord,
    notices: string[],
  ): Promise<void> {
    const at = formatSeen(clock.now());
    await state.update((m) => void addHit(m, found.id, at));
    await log({ kind: "hit", id: found.id, text: record.message });
    // The notice counts the hit it reports.
    const entry = {
      ...found.entry,
      hits: found.entry.hits + 1,
      lastSeen: laterSeen(found.entry.lastSeen, at),
    };
    // A hit that carries the fix answers any wait on it, too.
    if (oneLine(entry.fix) !== "")
      s.holding = s.holding.filter((f) => f !== entry.fingerprint);
    else if (found.injectable) {
      const outcome = await claims.claim({
        id: entry.fingerprint,
        agent,
        session,
      });
      if (!outcome.granted)
        return hold(s, rt, entry.fingerprint, found.id, outcome, notices);
      if (fresh(outcome)) await log({ kind: "claim", id: found.id });
    }
    await tell(
      rt.injector.offer({ kind: "hit", hit: { ...found, entry } }),
      notices,
    );
  }

  // A miss: only the agent that claims the new fingerprint appends its entry.
  async function onMiss(
    s: SessionState,
    rt: Runtime,
    record: CaptureRecord,
    notices: string[],
  ): Promise<string | undefined> {
    const outcome = await claims.claim({
      id: record.signature,
      agent,
      session,
    });
    if (!outcome.granted) {
      await hold(
        s,
        rt,
        record.signature,
        `new error ${record.signature}`,
        outcome,
        notices,
      );
      return undefined;
    }
    const { id } = await store.append({
      title: record.title,
      signature: record.signature,
      category: record.displayCategory,
      meta: {
        cat: record.category,
        ...(record.code === undefined ? {} : { code: record.code }),
      },
      raw: record.raw,
    });
    await log({ kind: "miss", id, text: record.message });
    await log({ kind: "claim", id });
    await tell(rt.injector.offer({ kind: "miss", id }), notices);
    return id;
  }

  // Pass on the fixes this session is waiting for. A fingerprint stops being
  // waited for once its fix is delivered, or once nobody holds its claim and
  // it still has no fix, so the agent can take the problem on itself. A fix the
  // budget cannot carry now is tried again on the next hook call.
  async function deliver(
    s: SessionState,
    rt: Runtime,
    machine: MachineState,
    notices: string[],
  ): Promise<void> {
    if (s.holding.length === 0) return;
    const entries = await readEntries(machine);
    const live = await claims.read();
    const now = clock.now();
    const waiting: string[] = [];
    for (const fingerprint of s.holding) {
      const entry = entries.find((e) => e.fingerprint === fingerprint);
      if (entry === undefined || oneLine(entry.fix) === "") {
        if (activeClaim(live, fingerprint, now) !== undefined)
          waiting.push(fingerprint);
        continue;
      }
      const hit: Hit = {
        matched: true,
        id: entry.id,
        entry,
        via: "exact",
        approximate: false,
        similarity: 1,
        injectable: entry.status !== "wontfix",
      };
      const notice = rt.injector.offer({ kind: "hit", hit }, true);
      if (notice === undefined && entry.status !== "wontfix")
        waiting.push(fingerprint);
      await tell(notice, notices);
    }
    s.holding = waiting;
  }

  return {
    async poll() {
      return sessionFile.update(async (s) => {
        if (s.holding.length === 0) return [];
        const machine = (await state.read()).state;
        const before = structuredClone(machine.trust);
        const rt = restore(s, machine.trust);
        rt.injector.beginStep();
        const notices: string[] = [];
        await deliver(s, rt, machine, notices);
        await persist(s, rt, before);
        return notices;
      });
    },

    async recordFix(id, fix) {
      if (oneLine(fix) === "") throw new RangeError("a fix cannot be blank");
      const entry = await store.update(id, {
        fix: fix.trim(),
        status: "fixed",
      });
      if (entry === undefined) return undefined;
      await log({ kind: "fix", id, text: entry.fix });
      if (await claims.release(entry.fingerprint))
        await log({ kind: "release", id, text: "fix recorded" });
      return entry;
    },

    async beginTurn() {
      return sessionFile.update(async (s) => {
        const machine = (await state.read()).state;
        const before = structuredClone(machine.trust);
        const rt = restore(s, machine.trust);
        rt.injector.beginTurn();
        rt.tracker.beginTurn();
        const notices: string[] = [];
        await deliver(s, rt, machine, notices);
        await persist(s, rt, before);
        return notices;
      });
    },

    async endSession() {
      const released = await claims.releaseSession(session);
      for (const fingerprint of released)
        await log({ kind: "release", id: fingerprint, text: "session ended" });
      await sessionFile.remove();
      return released;
    },

    async success(call) {
      const outcome = callOutcome(call);
      if (!outcome.ok) return [];
      return sessionFile.update(async (s) => {
        const machine = (await state.read()).state;
        const before = structuredClone(machine.trust);
        const rt = restore(s, machine.trust);
        rt.injector.beginStep();
        const notices: string[] = [];
        const resolved = rt.tracker.succeeded(outcome.keys);
        if (resolved.length > 0) {
          const entries = await readEntries(machine);
          for (const id of resolved) {
            const entry = entries.find((e) => e.id === id);
            if (entry === undefined) continue;
            await log({ kind: "resolve", id });
            if (oneLine(entry.fix) !== "") rt.trust.succeeded(id, entry.fix);
            else if (rt.tracker.ask(id))
              await tell(rt.injector.ask(id), notices);
          }
        }
        await deliver(s, rt, machine, notices);
        await persist(s, rt, before);
        return notices;
      });
    },

    async failure(capture, call) {
      const classified = classify(capture, new TransientCounter(), o.capture);
      if (classified === undefined || classified.decision !== "record")
        return [];
      const { record } = classified;
      const outcome = callOutcome(call);

      return sessionFile.update(async (s) => {
        const machine = (await state.read()).state;
        const before = structuredClone(machine.trust);
        const rt = restore(s, machine.trust);
        rt.injector.beginStep();
        const notices: string[] = [];

        const found = match(
          {
            category: record.category,
            code: record.code,
            message: record.message,
          },
          indexEntries(await readEntries(machine)),
          o.match,
        );
        let id: string | undefined;
        if (found.matched) {
          id = found.id;
          await onHit(s, rt, found, record, notices);
        } else id = await onMiss(s, rt, record, notices);
        if (!outcome.ok && id !== undefined)
          rt.tracker.occurred(id, outcome.key);
        await deliver(s, rt, machine, notices);
        await persist(s, rt, before);
        return notices;
      });
    },
  };
}
