// Per-session state for hook processes: sessions/<id>.json in the memory
// directory.
//
// Claude Code starts a new process for every hook call, so whatever a session
// has to remember between calls lives here: the notice budgets (CapTracker),
// the resolution watches (ResolutionTracker), the fixes injected this turn
// (FixTrust), and the entries the session is holding for while another agent
// diagnoses them. Claude Code can run the hooks of parallel tool calls at the
// same time, so every change takes a lock of the session's own.
//
// A missing or unreadable file reads as a fresh session: losing it only resets
// budgets and watches, it never loses knowledge, which lives in ANTIBODIES.md.
import { join } from "node:path";
import { sha256Hex } from "./sha256";
import type { CapSnapshot } from "./notice";
import type { ResolutionSnapshot } from "./resolve-detect";
import {
  DEFAULT_STORE_OPTIONS,
  nodeStoreFs,
  systemClock,
  withFileLock,
  writeFileAtomic,
} from "./store";
import type { LockOptions, StoreClock, StoreFs } from "./store";

/** The version every session file carries. */
export const SESSION_VERSION = 1;

/** The directory, inside the memory directory, that holds the session files. */
export const SESSIONS_DIR_NAME = "sessions";

/** What one session remembers between hook calls. */
export interface SessionState {
  version: typeof SESSION_VERSION;
  session: string;
  caps: CapSnapshot;
  resolution: ResolutionSnapshot;
  /** Entries whose fix was injected in the current turn. */
  trustTurn: string[];
  /** Entries this session hit while another agent was diagnosing them. */
  holding: string[];
}

/** A session with nothing remembered yet. */
export function freshSession(session: string): SessionState {
  return {
    version: SESSION_VERSION,
    session,
    caps: { step: 0, turn: 0, perId: {} },
    resolution: { turn: 0, watches: [], asked: [] },
    trustTurn: [],
    holding: [],
  };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The file name a session's state is kept under. A session id that is not a
 * plain token is hashed, so no id can name a path outside the directory.
 *
 * @param session - the harness's session id.
 */
export function sessionFileName(session: string): string {
  const base = SAFE_ID.test(session)
    ? session
    : sha256Hex(session).slice(0, 32);
  return `${base}.json`;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/**
 * Parse a session file. Snapshots are passed through for their own restore()
 * to validate; the lists are filtered to strings.
 *
 * @param text - the file's contents.
 * @param session - the session it should belong to.
 * @returns the state, or undefined when the file is not this session's.
 */
export function parseSession(
  text: string,
  session: string,
): SessionState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== SESSION_VERSION || raw.session !== session)
    return undefined;
  const fresh = freshSession(session);
  const record = (v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  return {
    ...fresh,
    caps: record(raw.caps) ? (raw.caps as CapSnapshot) : fresh.caps,
    resolution: record(raw.resolution)
      ? (raw.resolution as ResolutionSnapshot)
      : fresh.resolution,
    trustTurn: strings(raw.trustTurn),
    holding: strings(raw.holding),
  };
}

/** One session's state file. */
export interface SessionFile {
  /** The state; a missing or unreadable file reads as a fresh session. */
  read(): Promise<SessionState>;
  /**
   * Change the state under the session's lock and write it back atomically.
   * `mutate` may be async: the lock is held until it settles, so work that
   * reads and writes other memory files stays one at a time per session. The
   * lock order is always the session's lock, then the memory directory's.
   */
  update<T>(mutate: (state: SessionState) => T | Promise<T>): Promise<T>;
  /** Forget the session, when it ends. */
  remove(): Promise<void>;
}

/**
 * Bind one session's state file inside a memory directory.
 *
 * @param memory - the memory directory, from memoryDir().
 * @param session - the harness's session id.
 * @param options - lock settings; anything missing takes the store's default.
 * @param fs - filesystem; defaults to the real one.
 * @param clock - time; defaults to the real one.
 */
export function createSessionFile(
  memory: string,
  session: string,
  options: Partial<LockOptions> = {},
  fs: StoreFs = nodeStoreFs(),
  clock: StoreClock = systemClock(),
): SessionFile {
  const o: LockOptions = { ...DEFAULT_STORE_OPTIONS, ...options };
  const file = join(memory, SESSIONS_DIR_NAME, sessionFileName(session));
  const lock = `${file}.lock`;

  async function read(): Promise<SessionState> {
    const text = await fs.readFile(file);
    return (
      (text === undefined ? undefined : parseSession(text, session)) ??
      freshSession(session)
    );
  }

  return {
    read,
    update: (mutate) =>
      withFileLock(lock, o, fs, clock, async () => {
        const state = await read();
        const result = await mutate(state);
        await writeFileAtomic(fs, file, `${JSON.stringify(state)}\n`);
        return result;
      }),
    remove: () => fs.remove(file),
  };
}
