// The relay's HTTP service (src/relay.ts), for `antibody relay serve`.
//
//   GET  /v1/fixes?since=N   the fixes changed after N: { seq, document }
//   POST /v1/fixes           { document }: take in a machine's fixes; { seq, accepted }
//   DELETE /v1/fixes/<key>   remove a fix and block its fingerprint; the owner's token only
//   GET  /health             "ok", without a token, for a load balancer
//
// Every /v1 request carries `Authorization: Bearer <token>`, one of the relay's
// tokens, compared by its SHA-256 so the comparison says nothing about the
// token. Each token may push a limited number of times a minute; a push past it
// gets a 429 with Retry-After. The state is saved to one JSON file after every change, by atomic rename.
//
// It speaks plain HTTP. Run it behind a reverse proxy that terminates TLS when
// machines reach it over a network.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  acceptFixes,
  emptyRelay,
  fixesSince,
  parseRelayState,
  RELAY_MAX_BYTES,
  removeFix,
} from "./relay";
import type { RelayState } from "./relay";
import { sha256Hex } from "./sha256";
import { nodeStoreFs, writeFileAtomic } from "./store";
import type { StoreFs } from "./store";

/** The shortest token the relay accepts. */
export const RELAY_MIN_TOKEN = 16;

const FINGERPRINT_PATH = /^[0-9a-f]{12}$/;

/** The pushes one token may make in a minute, unless the relay says otherwise. */
export const RELAY_PUSHES_PER_MINUTE = 60;

const MINUTE_MS = 60_000;

export interface RelayServerOptions {
  /**
   * The secrets the machines send, one per machine. Removing one and restarting
   * the relay revokes it.
   */
  tokens: readonly string[];
  /** The JSON file the state is kept in. */
  dataFile: string;
  port: number;
  host: string;
  fs?: StoreFs;
  /** The most pushes one token may make in a minute; more get a 429. */
  pushesPerMinute?: number;
  /** The clock the push limit reads, in milliseconds; the real one by default. */
  now?: () => number;
  /**
   * The owner's secret, which alone may remove a fix. Optional: without it a
   * relay cannot remove fixes.
   */
  adminToken?: string;
}

/** A running relay. */
export interface RelayServer {
  /** The port it listens on, which a port of 0 chose. */
  port: number;
  /** How many fixes it holds. */
  fixes(): number;
  close(): Promise<void>;
}

/** Why a saved state could not be loaded. */
export class RelayStateError extends Error {}

/**
 * Load the saved state, or start empty when there is none.
 *
 * @throws RelayStateError when the file is there and is not a relay state.
 */
export async function loadRelayState(
  dataFile: string,
  fs: StoreFs = nodeStoreFs(),
): Promise<RelayState> {
  const text = await fs.readFile(dataFile);
  if (text === undefined) return emptyRelay();
  const state = parseRelayState(text);
  if (state === undefined)
    throw new RelayStateError(`${dataFile} is not a relay's state`);
  return state;
}

const send = (
  res: ServerResponse,
  status: number,
  body: unknown,
  type = "application/json",
) => {
  const text =
    type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": type });
  res.end(text);
};

/**
 * The request's body, or undefined when it runs past `max` bytes: the rest is
 * read and dropped, so the answer can still be sent.
 */
function readBody(
  req: IncomingMessage,
  max: number,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (part: Buffer) => {
      size += part.length;
      if (size <= max) parts.push(part);
    });
    req.on("end", () =>
      resolve(size > max ? undefined : Buffer.concat(parts).toString("utf8")),
    );
    req.on("error", reject);
  });
}

/**
 * Start a relay.
 *
 * @param o - the token, the state file, and where to listen.
 */
export async function startRelay(o: RelayServerOptions): Promise<RelayServer> {
  if (o.tokens.length === 0) throw new RangeError("the relay needs a token");
  for (const token of o.tokens)
    if (token.length < RELAY_MIN_TOKEN)
      throw new RangeError(
        `each of the relay's tokens must be at least ${RELAY_MIN_TOKEN} characters`,
      );
  if (o.adminToken !== undefined && o.adminToken.length < RELAY_MIN_TOKEN)
    throw new RangeError(
      `the relay's admin token must be at least ${RELAY_MIN_TOKEN} characters`,
    );
  const fs = o.fs ?? nodeStoreFs();
  let state = await loadRelayState(o.dataFile, fs);
  // Each token is compared by its hash, and counted for its own push limit.
  const known = new Set(o.tokens.map((t) => sha256Hex(`Bearer ${t}`)));
  const admin =
    o.adminToken === undefined
      ? undefined
      : sha256Hex(`Bearer ${o.adminToken}`);
  const limit = o.pushesPerMinute ?? RELAY_PUSHES_PER_MINUTE;
  const clock = o.now ?? (() => Date.now());
  const pushes = new Map<string, number[]>();
  // Whether this token may push now, and the time it recorded the push.
  const mayPush = (key: string): number | undefined => {
    const now = clock();
    const recent = (pushes.get(key) ?? []).filter((t) => now - t < MINUTE_MS);
    if (recent.length >= limit) {
      pushes.set(key, recent);
      return recent[0]! + MINUTE_MS - now;
    }
    recent.push(now);
    pushes.set(key, recent);
    return undefined;
  };
  // Changes are saved one at a time, in the order they were made.
  let saving: Promise<void> = Promise.resolve();
  const save = (next: RelayState) => {
    saving = saving.then(() =>
      writeFileAtomic(fs, o.dataFile, `${JSON.stringify(next)}\n`),
    );
    return saving;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (url.pathname === "/health" && req.method === "GET")
      return send(res, 200, "ok\n", "text/plain");
    const removal = /^\/v1\/fixes\/([^/]+)$/.exec(url.pathname);
    if (url.pathname !== "/v1/fixes" && removal === null)
      return send(res, 404, { error: "not found" });
    const key = sha256Hex(req.headers.authorization ?? "");
    if (removal !== null) {
      // Only the owner removes a fix: a machine's token is refused, not just
      // unknown, so the owner's error is not mistaken for a typo.
      if (admin === undefined || key !== admin) {
        if (known.has(key))
          return send(res, 403, {
            error: "removing a fix takes the owner's token",
          });
        return send(res, 401, { error: "a missing or wrong token" });
      }
      if (req.method !== "DELETE") return send(res, 405, { error: "DELETE" });
      const fingerprint = decodeURIComponent(removal[1] ?? "");
      if (!FINGERPRINT_PATH.test(fingerprint))
        return send(res, 400, { error: "a fingerprint of twelve hex digits" });
      const result = removeFix(state, fingerprint);
      state = result.state;
      await save(state);
      return send(res, 200, { seq: state.seq, removed: result.removed });
    }
    if (!known.has(key))
      return send(res, 401, { error: "a missing or wrong token" });
    if (req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? 0);
      if (!Number.isInteger(since) || since < 0)
        return send(res, 400, { error: "since takes a whole number" });
      const { seq, text, count, removed } = fixesSince(state, since);
      return send(res, 200, { seq, count, document: text, removed });
    }
    if (req.method !== "POST") return send(res, 405, { error: "GET or POST" });
    const wait = mayPush(key);
    if (wait !== undefined) {
      res.setHeader("retry-after", String(Math.ceil(wait / 1000)));
      return send(res, 429, { error: "too many pushes; wait and try again" });
    }
    const body = await readBody(req, RELAY_MAX_BYTES * 2);
    if (body === undefined) return send(res, 413, { error: "too large" });
    let document: unknown;
    try {
      document = (JSON.parse(body) as { document?: unknown }).document;
    } catch {
      document = undefined;
    }
    if (typeof document !== "string")
      return send(res, 400, { error: "a body of { document }" });
    const result = acceptFixes(state, document);
    if ("error" in result) return send(res, 400, { error: result.error });
    if (result.accepted > 0) {
      state = result.state;
      await save(state);
    }
    return send(res, 200, {
      seq: state.seq,
      accepted: result.accepted,
      ignored: result.ignored,
    });
  };

  const http = process.getBuiltinModule("node:http");
  const server: Server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "the relay failed" });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => resolve());
  });
  const address = server.address();
  return {
    port:
      typeof address === "object" && address !== null ? address.port : o.port,
    fixes: () => state.fixes.length,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
