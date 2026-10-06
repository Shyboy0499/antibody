// Syncing a memory with a relay (src/relay.ts): pushing the fixes this machine
// found, and pulling those the other machines found.
//
// The environment configures it, so a cloud agent's environment settings are
// all a fleet needs:
//
//   ANTIBODY_RELAY         the relay's URL, http or https
//   ANTIBODY_RELAY_TOKEN   its token
//   ANTIBODY_RELAY_TRUST   `review` (the default): what is pulled waits for a
//                          person, as an import does; `fleet`: every machine
//                          holding the token is trusted as one fleet, and what
//                          is pulled reaches agents at once
//
// A pulled fix comes in as `antibody import` brings one in: never replacing a
// fix this machine has, respecting `wontfix` and what a person rejected.
// `relay.json` in the memory directory remembers how far it has pulled and
// what it has pushed, so a sync sends and takes only what changed. A lock of
// its own keeps two processes on one machine from syncing at once.
import { join } from "node:path";
import { importDocument } from "./exchange-cli";
import { exportDocument, exportable } from "./exchange";
import { filesIn } from "./paths";
import {
  createStore,
  nodeStoreFs,
  parseDocument,
  systemClock,
  withFileLock,
  writeFileAtomic,
} from "./store";
import type { Entry, StoreClock, StoreFs } from "./store";
import { fixSig } from "./trust";

/** The environment variable that names the relay. */
export const RELAY_URL_ENV = "ANTIBODY_RELAY";

/** The environment variable that says how far the relay is trusted. */
export const RELAY_TRUST_ENV = "ANTIBODY_RELAY_TRUST";

/** The file in the memory directory that remembers the sync. */
export const RELAY_STATE_FILE = "relay.json";

/** How long one request to the relay may take. */
export const RELAY_TIMEOUT_MS = 5_000;

/** How a machine reaches a relay, and how far it trusts it. */
export interface RelayConfig {
  url: string;
  token: string;
  trust: "review" | "fleet";
}

/**
 * The relay the environment configures.
 *
 * @returns the configuration, undefined when no relay is set, or what is wrong.
 */
export function relayConfig(
  env: NodeJS.ProcessEnv,
): RelayConfig | undefined | { error: string } {
  const raw = env[RELAY_URL_ENV]?.trim() ?? "";
  if (raw === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `${RELAY_URL_ENV} is not a URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { error: `${RELAY_URL_ENV} must be an http or https URL` };
  const token = env.ANTIBODY_RELAY_TOKEN ?? "";
  if (token.length < 16)
    return {
      error:
        "ANTIBODY_RELAY_TOKEN must hold the relay's token, 16 characters or more",
    };
  const trust = env[RELAY_TRUST_ENV]?.trim() || "review";
  if (trust !== "review" && trust !== "fleet")
    return { error: `${RELAY_TRUST_ENV} takes review or fleet` };
  return { url: url.href.replace(/\/+$/, ""), token, trust };
}

/** What a sync remembers between runs. */
interface SyncState {
  url: string;
  /** The relay's sequence number this machine has pulled up to. */
  seq: number;
  /** For each fingerprint pushed or pulled, the fix it carried. */
  known: Record<string, string>;
}

function readSyncState(text: string | undefined, url: string): SyncState {
  const fresh: SyncState = { url, seq: 0, known: {} };
  if (text === undefined) return fresh;
  try {
    const raw = JSON.parse(text) as Partial<SyncState>;
    if (
      raw.url !== url ||
      !Number.isInteger(raw.seq) ||
      typeof raw.known !== "object" ||
      raw.known === null
    )
      return fresh;
    return { url, seq: raw.seq as number, known: { ...raw.known } };
  } catch {
    return fresh;
  }
}

/** What one sync did. */
export interface SyncResult {
  /** Fixes sent to the relay. */
  pushed: number;
  /** Fixes taken in from the relay. */
  pulled: number;
  /** Whether what was taken in waits for a person's review. */
  held: boolean;
}

/** What syncRelay() takes from its caller; injected in tests. */
export interface SyncDeps {
  fetch?: typeof fetch;
  fs?: StoreFs;
  clock?: StoreClock;
  timeoutMs?: number;
}

const keyOf = (entry: Entry) => entry.meta.sig ?? entry.fingerprint;

/**
 * Push this machine's new and changed fixes to the relay, then pull what
 * changed there since the last sync.
 *
 * @param memory - the memory directory.
 * @param config - the relay, from relayConfig().
 * @param deps - fetch, the file system and the clock; injected in tests.
 * @returns what it did, or why it could not.
 */
export async function syncRelay(
  memory: string,
  config: RelayConfig,
  deps: SyncDeps = {},
): Promise<SyncResult | { error: string }> {
  const fs = deps.fs ?? nodeStoreFs();
  const clock = deps.clock ?? systemClock();
  const get = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? RELAY_TIMEOUT_MS;
  const headers = {
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
  };
  const ask = async (path: string, init: RequestInit = {}) => {
    const res = await get(`${config.url}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok)
      throw new Error(
        `the relay answered ${res.status}${typeof body.error === "string" ? `: ${body.error}` : ""}`,
      );
    return body;
  };

  const stateFile = join(memory, RELAY_STATE_FILE);
  const lock = {
    lockStaleMs: 60_000,
    lockTimeoutMs: 1_000,
    lockRetryMs: 50,
  };
  try {
    return await withFileLock(
      join(memory, "relay.lock"),
      lock,
      fs,
      clock,
      async () => {
        const state = readSyncState(await fs.readFile(stateFile), config.url);
        const files = filesIn(memory);
        const store = createStore(files, {}, fs, clock);
        const entries = (await store.read()).blocks.map((b) => b.entry);

        // Push what is new or changed since the last sync.
        const changed = entries.filter(
          (e) => exportable(e) && state.known[keyOf(e)] !== fixSig(e.fix),
        );
        if (changed.length > 0) {
          await ask("/v1/fixes", {
            method: "POST",
            body: JSON.stringify({ document: exportDocument(changed).text }),
          });
          for (const e of changed) state.known[keyOf(e)] = fixSig(e.fix);
        }

        // Pull what changed on the relay.
        const since = await ask(`/v1/fixes?since=${state.seq}`);
        const document =
          typeof since.document === "string" ? since.document : "";
        let pulled = 0;
        if (document !== "") {
          const outcome = await importDocument(
            { store, entries, files },
            document,
            `the relay ${new URL(config.url).host}`,
            false,
            config.trust === "fleet",
          );
          if ("error" in outcome) throw new Error(outcome.error);
          pulled = outcome.count;
          // A fix that came from the relay is not news to push back to it.
          const came = new Map(
            parseDocument(document).blocks.map((b) => [
              keyOf(b.entry),
              fixSig(b.entry.fix),
            ]),
          );
          for (const e of (await store.read()).blocks.map((b) => b.entry))
            if (came.get(keyOf(e)) === fixSig(e.fix))
              state.known[keyOf(e)] = fixSig(e.fix);
        }
        if (typeof since.seq === "number") state.seq = since.seq;
        await writeFileAtomic(fs, stateFile, `${JSON.stringify(state)}\n`);
        return {
          pushed: changed.length,
          pulled,
          held: config.trust !== "fleet",
        };
      },
    );
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** How often the MCP server syncs with the relay. */
export const RELAY_SYNC_MS = 30_000;

/** How long the last sync, as the server stops, may take per request. */
export const RELAY_LAST_SYNC_TIMEOUT_MS = 2_000;

/** What startRelaySync() takes from its caller; injected in tests. */
export interface BackgroundSyncDeps {
  intervalMs?: number;
  sync?: typeof syncRelay;
  /** Where a configuration mistake, or a failed sync under ANTIBODY_DEBUG, is said. */
  log?: (line: string) => void;
}

/**
 * Keep a memory in sync with the relay the environment names, in the
 * background: once at once, then every RELAY_SYNC_MS, never two at a time.
 * A configuration mistake is said once; a failed sync only under
 * ANTIBODY_DEBUG, so a relay that is down does not fill the harness's log.
 *
 * @param memory - finds the memory directory; a throw means there is none.
 * @param env - the environment that configures the relay.
 * @param deps - the interval, the sync and the log; injected in tests.
 * @returns a function that stops it, after one last sync to push what was
 *   recorded since the previous one.
 */
export function startRelaySync(
  memory: () => string,
  env: NodeJS.ProcessEnv,
  deps: BackgroundSyncDeps = {},
): () => Promise<void> {
  const config = relayConfig(env);
  const log = deps.log ?? (() => undefined);
  if (config === undefined) return async () => undefined;
  if ("error" in config) {
    log(`antibody: no relay sync: ${config.error}\n`);
    return async () => undefined;
  }
  let dir: string;
  try {
    dir = memory();
  } catch {
    return async () => undefined;
  }
  const sync = deps.sync ?? syncRelay;
  const debug = env.ANTIBODY_DEBUG === "1";
  let running: Promise<void> | undefined;
  const once = (timeoutMs?: number) => {
    running ??= sync(dir, config, timeoutMs === undefined ? {} : { timeoutMs })
      .then((result) => {
        if ("error" in result && debug)
          log(`antibody: relay sync failed: ${result.error}\n`);
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  void once();
  const timer = setInterval(
    () => void once(),
    deps.intervalMs ?? RELAY_SYNC_MS,
  );
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
    await once(RELAY_LAST_SYNC_TIMEOUT_MS);
  };
}
