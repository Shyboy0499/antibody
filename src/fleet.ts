// The fleet loop: what antibody does when an agent's tool call fails or
// succeeds, in one step per hook call. It joins what is built so far - capture,
// matching, the store, state, fix trust, notices, the event log and the
// session file - and returns the notices to show the agent.
//
// Every call runs inside the session's lock (src/session.ts), so the hooks of
// parallel tool calls in one session take turns; the store, state and claims
// take the memory directory's lock inside it, always in that order.
//
// Each hook call is its own process. The engine is created per call, restores
// the session's budgets, watches and turn from the session file, and saves them
// back before it returns. Fix-trust records live in state.json, shared by the
// fleet; only the records this call changed are written back.
import { TransientCounter, classify } from "./capture";
import type { CaptureInput, CaptureOptions } from "./capture";
import { appendEvent } from "./events";
import type { NewEvent } from "./events";
import { Injector } from "./injector";
import { indexEntries, match } from "./match";
import type { MatchOptions } from "./match";
import { CapTracker, estimateTokens } from "./notice";
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
}

export const DEFAULT_FLEET_OPTIONS: FleetOptions = {
  inject: "hit-only",
  match: {},
  capture: {},
  lockTimeoutMs: 2_000,
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

  return {
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
        let id: string;
        if (found.matched) {
          id = found.id;
          const at = formatSeen(clock.now());
          await state.update((m) => void addHit(m, found.id, at));
          await log({ kind: "hit", id, text: record.message });
          // The notice counts the hit it reports.
          const entry = {
            ...found.entry,
            hits: found.entry.hits + 1,
            lastSeen: laterSeen(found.entry.lastSeen, at),
          };
          await tell(
            rt.injector.offer({ kind: "hit", hit: { ...found, entry } }),
            notices,
          );
        } else {
          ({ id } = await store.append({
            title: record.title,
            signature: record.signature,
            category: record.displayCategory,
            meta: {
              cat: record.category,
              ...(record.code === undefined ? {} : { code: record.code }),
            },
            raw: record.raw,
          }));
          await log({ kind: "miss", id, text: record.message });
          await tell(rt.injector.offer({ kind: "miss", id }), notices);
        }
        if (!outcome.ok) rt.tracker.occurred(id, outcome.key);
        await persist(s, rt, before);
        return notices;
      });
    },
  };
}
