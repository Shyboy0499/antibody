// Claims: which agent is diagnosing which entry right now.
//
// The first agent to hit a new fingerprint claims its entry. An agent that hits
// the same entry while the claim is live is told a peer is already on it,
// instead of starting a second diagnosis of the same error. A claim ends when
// the claimant records the fix, when its session ends, or when its time to live
// runs out, so a crashed agent cannot hold an entry forever.
//
// Claims live in claims.json in the memory directory, rewritten under the
// store's lock with an atomic rename. The decisions are pure functions over a
// ClaimsState; createClaimsFile() binds them to the file.
import type { KbFiles } from "./paths";
import {
  DEFAULT_STORE_OPTIONS,
  nodeStoreFs,
  systemClock,
  withFileLock,
  writeFileAtomic,
} from "./store";
import type { LockOptions, StoreClock, StoreFs } from "./store";

/** The version claims.json carries. */
export const CLAIMS_VERSION = 1;

/** How long a claim lasts unless its holder renews or releases it. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

/** One agent working on one entry. */
export interface Claim {
  id: string;
  agent: string;
  session: string;
  /** When the claim was first granted, ISO 8601. */
  since: string;
  /** When it lapses unless renewed, ISO 8601. */
  expires: string;
}

/** Everything claims.json holds, keyed by entry ID. */
export interface ClaimsState {
  version: typeof CLAIMS_VERSION;
  claims: Record<string, Claim>;
}

/** Who asks to work on which entry. */
export interface ClaimRequest {
  id: string;
  agent: string;
  session: string;
}

/** A claim granted to the asker, or refused because another session holds it. */
export type ClaimOutcome =
  { granted: true; claim: Claim } | { granted: false; holder: Claim };

/** An empty state: nobody is working on anything. */
export function emptyClaims(): ClaimsState {
  return { version: CLAIMS_VERSION, claims: {} };
}

function isClaim(value: unknown, id: string): value is Claim {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.id === id &&
    typeof c.agent === "string" &&
    typeof c.session === "string" &&
    typeof c.since === "string" &&
    typeof c.expires === "string" &&
    !Number.isNaN(Date.parse(c.expires))
  );
}

/**
 * Parse claims.json. A record of the wrong shape is dropped on its own.
 *
 * @param text - the file's contents.
 * @returns the state, or undefined when the file is not version 1 JSON.
 */
export function parseClaims(text: string): ClaimsState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== CLAIMS_VERSION) return undefined;
  const state = emptyClaims();
  if (typeof raw.claims === "object" && raw.claims !== null)
    for (const [id, claim] of Object.entries(raw.claims))
      if (isClaim(claim, id)) state.claims[id] = claim;
  return state;
}

/** claims.json's text for a state. */
export function renderClaims(state: ClaimsState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * The live claim on an entry, if there is one.
 *
 * @param state - the claims.
 * @param id - the entry.
 * @param now - the current time.
 */
export function activeClaim(
  state: ClaimsState,
  id: string,
  now: Date,
): Claim | undefined {
  const claim = state.claims[id];
  return claim !== undefined && Date.parse(claim.expires) > now.getTime()
    ? claim
    : undefined;
}

/**
 * Drop every claim whose time has run out.
 *
 * @returns the IDs that were released.
 */
export function pruneExpired(state: ClaimsState, now: Date): string[] {
  const released: string[] = [];
  for (const id of Object.keys(state.claims))
    if (activeClaim(state, id, now) === undefined) {
      delete state.claims[id];
      released.push(id);
    }
  return released;
}

/**
 * Ask to work on an entry. The asker gets the claim when nobody else holds a
 * live one; asking again from the holder's own session renews it, keeping
 * when it began.
 *
 * @param state - the claims; changed in place.
 * @param request - who asks for which entry.
 * @param now - the current time.
 * @param ttlMs - how long the claim lasts.
 */
export function claim(
  state: ClaimsState,
  request: ClaimRequest,
  now: Date,
  ttlMs: number = CLAIM_TTL_MS,
): ClaimOutcome {
  const held = activeClaim(state, request.id, now);
  if (held !== undefined && held.session !== request.session)
    return { granted: false, holder: held };
  const granted: Claim = {
    id: request.id,
    agent: request.agent,
    session: request.session,
    since: held?.since ?? now.toISOString(),
    expires: new Date(now.getTime() + ttlMs).toISOString(),
  };
  state.claims[request.id] = granted;
  return { granted: true, claim: granted };
}

/**
 * End the claim on an entry: when it is held by `session`, or by anyone when no
 * session is given (the fix was recorded, whoever held it).
 *
 * @returns whether a claim was removed.
 */
export function release(
  state: ClaimsState,
  id: string,
  session?: string,
): boolean {
  const held = state.claims[id];
  if (held === undefined || (session !== undefined && held.session !== session))
    return false;
  delete state.claims[id];
  return true;
}

/**
 * End every claim a session holds, when that session ends.
 *
 * @returns the IDs that were released.
 */
export function releaseSession(state: ClaimsState, session: string): string[] {
  const released = Object.values(state.claims)
    .filter((c) => c.session === session)
    .map((c) => c.id);
  for (const id of released) delete state.claims[id];
  return released;
}

/** claims.json, bound to a memory directory. */
export interface ClaimsFile {
  /** The current claims; a missing or unreadable file reads as empty. */
  read(): Promise<ClaimsState>;
  claim(request: ClaimRequest): Promise<ClaimOutcome>;
  release(id: string, session?: string): Promise<boolean>;
  releaseSession(session: string): Promise<string[]>;
}

/** Settings for createClaimsFile(); anything missing takes its default. */
export interface ClaimsOptions extends LockOptions {
  ttlMs: number;
}

/**
 * Bind claims.json to a memory directory. Every change takes the store's lock,
 * drops expired claims, and replaces the file atomically; an unreadable file
 * is treated as empty and replaced.
 *
 * @param files - paths from filesIn().
 * @param options - lock settings and the claim time to live.
 * @param fs - filesystem; defaults to the real one.
 * @param clock - time; defaults to the real one.
 */
export function createClaimsFile(
  files: Pick<KbFiles, "claims" | "lock">,
  options: Partial<ClaimsOptions> = {},
  fs: StoreFs = nodeStoreFs(),
  clock: StoreClock = systemClock(),
): ClaimsFile {
  const o: ClaimsOptions = {
    ...DEFAULT_STORE_OPTIONS,
    ttlMs: CLAIM_TTL_MS,
    ...options,
  };

  async function load(): Promise<ClaimsState> {
    const text = await fs.readFile(files.claims);
    return (
      (text === undefined ? undefined : parseClaims(text)) ?? emptyClaims()
    );
  }

  async function update<T>(
    mutate: (state: ClaimsState, now: Date) => T,
  ): Promise<T> {
    return withFileLock(files.lock, o, fs, clock, async () => {
      const state = await load();
      const now = clock.now();
      pruneExpired(state, now);
      const result = mutate(state, now);
      await writeFileAtomic(fs, files.claims, renderClaims(state));
      return result;
    });
  }

  return {
    read: load,
    claim: (request) =>
      update((state, now) => claim(state, request, now, o.ttlMs)),
    release: (id, session) => update((state) => release(state, id, session)),
    releaseSession: (session) =>
      update((state) => releaseSession(state, session)),
  };
}
