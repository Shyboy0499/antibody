// Ported from dsh-errkb, src/inject.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE): fix trust. Section marks refer to dsh-errkb's design document.
//
// FixTrust counts, per entry, how often a fix was injected and how often the
// same entry was captured again later in the same turn. One recurrence turns
// the wording into "This fix failed here last time"; two with no recorded
// success stop the entry from being injected on this machine. Editing the
// entry's fix starts its count again. The state is a plain serializable object
// behind TrustStore, so it can live in state.json and survive a restart; it is
// machine-local and never written into the entries document.
import { sha256Hex } from "./sha256";
import { oneLine } from "./notice";
import type { TrustLevel } from "./notice";

/** One entry's trust counters. */
export interface TrustRecord {
  /** Notices that carried this entry's fix. */
  injected: number;
  /** Times the entry was captured again later in a turn that injected it. */
  recurredAfterInject: number;
  /** Times the fix was confirmed to work (T14). */
  succeeded: number;
  /** Hash of the fix text the counts are about. */
  fixSig: string;
}

/** Everything FixTrust keeps: plain data, safe to JSON.stringify. */
export interface TrustState {
  entries: Record<string, TrustRecord>;
}

/** Where trust state lives: state.json in the plugin, memory in tests. */
export interface TrustStore {
  /** The state to start from, synchronously. */
  load(): TrustState;
  save(state: TrustState): void;
  /**
   * For a store that reads asynchronously: the saved state, once read, or
   * undefined when there is none. Its records join the ones load() gave,
   * without replacing any that changed meanwhile. Never rejects.
   */
  loaded?: Promise<TrustState | undefined>;
}

/**
 * A TrustStore in memory. It saves a deep copy, so later changes to the saved
 * object do not leak in.
 *
 * @param initial - the state to start from.
 */
export function memoryTrustStore(
  initial: TrustState = { entries: {} },
): TrustStore {
  let state: TrustState = structuredClone(initial);
  return {
    load: () => structuredClone(state),
    save: (next) => {
      state = structuredClone(next);
    },
  };
}

/** Recurrences after which the wording turns to "failed here last time". */
export const DOUBT_AFTER = 1;

/** Recurrences, with no success, after which the ID is not injected. */
export const SUPPRESS_AFTER = 2;

/**
 * Hash a fix text, so an edited fix starts trusted again.
 *
 * @param fix - the entry's fix field.
 */
export function fixSig(fix: string): string {
  return sha256Hex(oneLine(fix)).slice(0, 12);
}

/**
 * The trust level a record gives.
 *
 * @param record - the record, if there is one.
 */
export function trustLevel(record: TrustRecord | undefined): TrustLevel {
  if (record === undefined) return "trusted";
  if (record.recurredAfterInject >= SUPPRESS_AFTER && record.succeeded === 0)
    return "suppressed";
  return record.recurredAfterInject >= DOUBT_AFTER ? "doubted" : "trusted";
}

/**
 * Per-machine fix trust. Call beginTurn() at each turn, seen() whenever a
 * captured error matches an entry, and injected() when a notice carried that
 * entry's fix.
 */
export class FixTrust {
  private state: TrustState;
  // `<scope>\0<id>` for every fix injected in its scope's current turn. The
  // scope is the session (T13), so one session's new turn does not forget
  // another session's injections.
  private readonly injectedThisTurn = new Set<string>();

  /** Settles once the store's asynchronous state, if any, has joined in. */
  readonly ready: Promise<void>;

  constructor(private readonly store: TrustStore = memoryTrustStore()) {
    this.state = store.load();
    this.ready = (store.loaded ?? Promise.resolve(undefined)).then((saved) => {
      for (const [id, record] of Object.entries(saved?.entries ?? {}))
        this.state.entries[id] ??= record;
    });
  }

  /** The record for an entry, or undefined when none applies to this fix. */
  record(id: string, fix: string): TrustRecord | undefined {
    const record = this.state.entries[id];
    return record?.fixSig === fixSig(fix) ? record : undefined;
  }

  /** The trust level of an entry's current fix. */
  level(id: string, fix: string): TrustLevel {
    return trustLevel(this.record(id, fix));
  }

  /**
   * A new turn in `scope`: recurrence is counted within one turn.
   *
   * @param scope - the session whose turn began; the default scope serves a
   *   caller with one session.
   */
  beginTurn(scope = ""): void {
    const prefix = `${scope}\0`;
    for (const key of this.injectedThisTurn)
      if (key.startsWith(prefix)) this.injectedThisTurn.delete(key);
  }

  /**
   * A captured error matched `id`. If its fix was injected earlier in this
   * turn of the same scope, the fix did not hold: count a recurrence.
   */
  seen(id: string, fix: string, scope = ""): void {
    const key = `${scope}\0${id}`;
    const record = this.record(id, fix);
    if (record === undefined || !this.injectedThisTurn.has(key)) return;
    record.recurredAfterInject++;
    this.injectedThisTurn.delete(key);
    this.store.save(this.state);
  }

  /** A notice carried `id`'s fix, in `scope`'s current turn. */
  injected(id: string, fix: string, scope = ""): void {
    const record = this.record(id, fix) ?? {
      injected: 0,
      recurredAfterInject: 0,
      succeeded: 0,
      fixSig: fixSig(fix),
    };
    record.injected++;
    this.state.entries[id] = record;
    this.injectedThisTurn.add(`${scope}\0${id}`);
    this.store.save(this.state);
  }

  /** The fix for `id` was confirmed to work (resolution detection, T14). */
  succeeded(id: string, fix: string): void {
    const record = this.record(id, fix);
    if (record === undefined) return;
    record.succeeded++;
    this.store.save(this.state);
  }

  /**
   * The entries whose fix was injected in `scope`'s current turn, so a hook
   * process can save them for the next call in the same turn.
   *
   * @param scope - the session.
   */
  injectedInTurn(scope = ""): string[] {
    const prefix = `${scope}\0`;
    return [...this.injectedThisTurn]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  /**
   * Carry on `scope`'s current turn from what injectedInTurn() saved.
   *
   * @param ids - entries injected earlier in the turn.
   * @param scope - the session.
   */
  restoreTurn(ids: readonly string[], scope = ""): void {
    for (const id of ids)
      if (typeof id === "string") this.injectedThisTurn.add(`${scope}\0${id}`);
  }

  /** A copy of the whole state, for persistence or `antibody_stats`. */
  snapshot(): TrustState {
    return structuredClone(this.state);
  }
}
