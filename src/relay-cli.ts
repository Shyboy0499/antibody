// `antibody relay`: share fixes between machines through a relay (src/relay.ts).
//
//   antibody relay serve [--port N] [--host H] [--data FILE]
//   antibody relay sync
//
// The token every machine sends is read from ANTIBODY_RELAY_TOKEN; a machine
// that syncs names the relay in ANTIBODY_RELAY (src/relay-client.ts). The relay
// runs until it is interrupted, and exits 0 then. Both exit 1 when they cannot
// do their work, and 2 on usage.
import { resolve } from "node:path";
import type { CliIo } from "./cli";
import { shown } from "./memory-cli";
import { memoryDir } from "./paths";
import type { GitRunner } from "./paths";
import {
  RELAY_TRUST_ENV,
  RELAY_URL_ENV,
  relayConfig,
  syncRelay,
} from "./relay-client";
import { RELAY_MIN_TOKEN, startRelay } from "./relay-server";
import type { RelayServer } from "./relay-server";

/** The port a relay listens on unless told otherwise. */
export const RELAY_DEFAULT_PORT = 4880;

/** The environment variable that holds the relay's token. */
export const RELAY_TOKEN_ENV = "ANTIBODY_RELAY_TOKEN";

const RELAY_USAGE = `usage: antibody relay serve [--port N] [--host H] [--data FILE]
       antibody relay sync
  --port N     the port to listen on (default ${RELAY_DEFAULT_PORT})
  --host H     the address to listen on (default 127.0.0.1)
  --data FILE  where the relay keeps its fixes (default antibody-relay.json)
The token every machine sends is read from ${RELAY_TOKEN_ENV}. A machine that
syncs names the relay in ${RELAY_URL_ENV}, and sets ${RELAY_TRUST_ENV}=fleet to
give agents what it pulls without a person's review.
`;

/** What `antibody relay` takes from its caller; injected in tests. */
export interface RelayDeps {
  cwd?: string;
  git?: GitRunner;
  /** Stops the relay; SIGINT or SIGTERM by default. */
  signal?: AbortSignal;
  /** Called once the relay listens. */
  onListening?: (server: RelayServer) => void;
}

/**
 * `antibody relay <command>`.
 *
 * @param args - the arguments after `relay`.
 * @param io - stdout, stderr and the environment.
 * @param deps - the working directory and the stop signal; injected in tests.
 */
export async function runRelay(
  args: readonly string[],
  io: CliIo,
  deps: RelayDeps = {},
): Promise<number> {
  const [command, ...rest] = args;
  if (command === "serve") return serve(rest, io, deps);
  if (command === "sync") return sync(rest, io, deps);
  io.stderr(
    `antibody: ${command === undefined ? "relay needs a command" : `unknown relay command: ${command}`}\n${RELAY_USAGE}`,
  );
  return 2;
}

/**
 * A signal that aborts on SIGINT or SIGTERM.
 *
 * @param emitter - where the signals arrive; the process by default.
 */
export function interrupted(
  emitter: Pick<NodeJS.EventEmitter, "once"> = process,
): AbortSignal {
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"])
    emitter.once(signal, () => stop.abort());
  return stop.signal;
}

async function serve(
  args: readonly string[],
  io: CliIo,
  deps: RelayDeps,
): Promise<number> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] as string;
    const value = args[i + 1];
    if (!["--port", "--host", "--data"].includes(flag) || value === undefined) {
      io.stderr(
        `antibody: unknown or incomplete option: ${flag}\n${RELAY_USAGE}`,
      );
      return 2;
    }
    flags.set(flag, value);
  }
  const port = Number(flags.get("--port") ?? RELAY_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    io.stderr(`antibody: --port takes a port number\n${RELAY_USAGE}`);
    return 2;
  }
  const token = io.env[RELAY_TOKEN_ENV] ?? "";
  if (token.length < RELAY_MIN_TOKEN) {
    io.stderr(
      `antibody: set ${RELAY_TOKEN_ENV} to a secret of at least ${RELAY_MIN_TOKEN} characters; every machine sends it\n`,
    );
    return 1;
  }
  const host = flags.get("--host") ?? "127.0.0.1";
  const cwd = deps.cwd ?? process.cwd();
  const dataFile = resolve(cwd, flags.get("--data") ?? "antibody-relay.json");
  let server: RelayServer;
  try {
    server = await startRelay({ token, dataFile, port, host });
  } catch (error) {
    io.stderr(
      `antibody: the relay could not start: ${(error as Error).message}\n`,
    );
    return 1;
  }
  io.stdout(
    `antibody relay: listening on http://${host}:${server.port}, holding ${server.fixes()} fixes in ${shown(cwd, dataFile)}\n`,
  );
  deps.onListening?.(server);
  const signal = deps.signal ?? interrupted();
  if (!signal.aborted)
    await new Promise((stop) =>
      signal.addEventListener("abort", stop, { once: true }),
    );
  await server.close();
  io.stdout(`antibody relay: stopped, holding ${server.fixes()} fixes\n`);
  return 0;
}

async function sync(
  args: readonly string[],
  io: CliIo,
  deps: RelayDeps,
): Promise<number> {
  if (args.length > 0) {
    io.stderr(`antibody: relay sync takes no options\n${RELAY_USAGE}`);
    return 2;
  }
  const config = relayConfig(io.env);
  if (config === undefined) {
    io.stderr(
      `antibody: no relay is set; set ${RELAY_URL_ENV} to its URL and ${RELAY_TOKEN_ENV} to its token\n`,
    );
    return 1;
  }
  if ("error" in config) {
    io.stderr(`antibody: ${config.error}\n`);
    return 1;
  }
  let memory: string;
  try {
    memory = memoryDir(deps.cwd ?? process.cwd(), deps.git, io.env);
  } catch (error) {
    io.stderr(`antibody: ${(error as Error).message}\n`);
    return 1;
  }
  const result = await syncRelay(memory, config);
  if ("error" in result) {
    io.stderr(`antibody: the relay sync failed: ${result.error}\n`);
    return 1;
  }
  const fixes = (n: number) => `${n} ${n === 1 ? "fix" : "fixes"}`;
  const came =
    result.pulled === 0
      ? ""
      : result.held
        ? ", held for your review: run `antibody review`"
        : ", given to agents as they meet the errors";
  io.stdout(
    `Pushed ${fixes(result.pushed)} to ${new URL(config.url).host}, and pulled ${fixes(result.pulled)}${came}.\n`,
  );
  return 0;
}
