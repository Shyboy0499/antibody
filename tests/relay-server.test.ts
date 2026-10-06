// The relay over real HTTP: its token, its two /v1 calls, its limits, its
// saved state, and `antibody relay serve`.
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli";
import type { CliIo } from "../src/cli";
import { RELAY_MAX_BYTES, parseRelayState } from "../src/relay";
import { interrupted, runRelay } from "../src/relay-cli";
import {
  RelayStateError,
  loadRelayState,
  startRelay,
} from "../src/relay-server";
import type { RelayServer } from "../src/relay-server";
import {
  DOCUMENT_HEADER,
  nodeStoreFs,
  parseDocument,
  renderEntry,
} from "../src/store";
import type { Entry } from "../src/store";

const TOKEN = "a-relay-token-long-enough";

const entry = (n: number, fix = `Fix number ${n}.`): Entry => ({
  id: `E-000${n}`,
  title: `[tool:Bash] failure number ${n}`,
  meta: { sig: `00000000000${n}`, cat: "tool" },
  fingerprint: `00000000000${n}`,
  category: "tool / Bash",
  firstSeen: "2026-10-05 09:00",
  lastSeen: "2026-10-05 10:00",
  hits: 3,
  trigger: "pnpm test",
  raw: `failure number ${n}`,
  fix,
  status: "fixed",
  notes: "",
});
const doc = (...entries: Entry[]) =>
  `${DOCUMENT_HEADER}\n${entries.map((e) => renderEntry(e)).join("\n")}`;

let dir: string;
let data: string;
let relay: RelayServer | undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "antibody-relay-")));
  data = join(dir, "relay.json");
});

afterEach(async () => {
  await relay?.close();
  relay = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const start = async (fs = nodeStoreFs()) => {
  relay = await startRelay({
    token: TOKEN,
    dataFile: data,
    port: 0,
    host: "127.0.0.1",
    fs,
  });
  return relay;
};

const call = async (
  path: string,
  init: RequestInit & { token?: string | null } = {},
) => {
  const { token = TOKEN, ...rest } = init;
  const res = await fetch(`http://127.0.0.1:${relay?.port}${path}`, {
    ...rest,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Plain text.
  }
  return { status: res.status, body: body as Record<string, unknown> };
};
const push = (document: string) =>
  call("/v1/fixes", { method: "POST", body: JSON.stringify({ document }) });

describe("the relay over HTTP", () => {
  it("takes a machine's fixes, saves them, and sends them to another", async () => {
    await start();
    expect(await push(doc(entry(1), entry(2)))).toEqual({
      status: 200,
      body: { seq: 2, accepted: 2, ignored: 0 },
    });
    expect(parseRelayState(readFileSync(data, "utf8"))?.fixes).toHaveLength(2);
    const pulled = await call("/v1/fixes?since=0");
    expect(pulled.status).toBe(200);
    expect(pulled.body.seq).toBe(2);
    expect(pulled.body.count).toBe(2);
    const entries = parseDocument(pulled.body.document as string).blocks;
    expect(entries.map((b) => b.entry.fix)).toEqual([
      "Fix number 1.",
      "Fix number 2.",
    ]);
    expect((await call("/v1/fixes?since=2")).body).toEqual({
      seq: 2,
      count: 0,
      document: "",
    });
    expect((await call("/v1/fixes")).body.count).toBe(2);
  });

  it("does not save a push that changes nothing", async () => {
    await start();
    await push(doc(entry(1)));
    const saved = readFileSync(data, "utf8");
    writeFileSync(data, "untouched");
    expect((await push(doc(entry(1)))).body).toEqual({
      seq: 1,
      accepted: 0,
      ignored: 0,
    });
    expect(readFileSync(data, "utf8")).toBe("untouched");
    expect(saved).not.toBe("untouched");
  });

  it("wants the token on every call but the health check", async () => {
    await start();
    expect(await call("/health", { token: null })).toEqual({
      status: 200,
      body: "ok\n",
    });
    for (const token of [null, "wrong-but-long-enough-token"])
      expect((await call("/v1/fixes", { token })).status).toBe(401);
  });

  it("answers bad requests with what was wrong", async () => {
    await start();
    expect((await call("/v1/fixes?since=-1")).status).toBe(400);
    expect((await call("/v1/fixes?since=x")).status).toBe(400);
    expect(
      (await call("/v1/fixes", { method: "POST", body: "{" })).body,
    ).toEqual({ error: "a body of { document }" });
    expect(
      (await call("/v1/fixes", { method: "POST", body: "{}" })).status,
    ).toBe(400);
    expect((await push("## E-1 · no header\n")).body.error).toMatch(
      /does not parse/,
    );
    expect((await push("x".repeat(RELAY_MAX_BYTES * 2))).status).toBe(413);
    expect((await call("/v1/fixes", { method: "PUT" })).status).toBe(405);
    expect((await call("/elsewhere")).status).toBe(404);
  });

  it("carries on from its saved state after a restart", async () => {
    await start();
    await push(doc(entry(1), entry(2)));
    await relay?.close();
    const again = await start();
    expect(again.fixes()).toBe(2);
    expect((await push(doc(entry(3)))).body.seq).toBe(3);
  });

  it("answers 500 when it cannot save", async () => {
    await start({
      ...nodeStoreFs(),
      writeFile: async () => {
        throw new Error("disk full");
      },
    });
    expect((await push(doc(entry(1)))).status).toBe(500);
  });

  it("will not start on a state that is not one, a short token, or a busy port", async () => {
    writeFileSync(data, "not a relay");
    await expect(loadRelayState(data)).rejects.toThrow(RelayStateError);
    await expect(start()).rejects.toThrow("is not a relay's state");
    rmSync(data);
    await expect(
      startRelay({
        token: "short",
        dataFile: data,
        port: 0,
        host: "127.0.0.1",
      }),
    ).rejects.toThrow(RangeError);
    const busy = await start();
    await expect(
      startRelay({
        token: TOKEN,
        dataFile: data,
        port: busy.port,
        host: "127.0.0.1",
      }),
    ).rejects.toThrow();
  });
});

describe("antibody relay serve", () => {
  const io = (env: NodeJS.ProcessEnv = { ANTIBODY_RELAY_TOKEN: TOKEN }) => {
    const sink = {
      out: "",
      err: "",
      readStdin: async () => "",
      stdout: (t: string) => void (sink.out += t),
      stderr: (t: string) => void (sink.err += t),
      env,
    };
    return sink as CliIo & { out: string; err: string };
  };

  it("serves until it is stopped", async () => {
    const stop = new AbortController();
    const sink = io();
    let port = 0;
    const code = runRelay(
      ["serve", "--port", "0", "--data", "relay.json"],
      sink,
      {
        cwd: dir,
        signal: stop.signal,
        onListening: async (server) => {
          port = server.port;
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          expect(await res.text()).toBe("ok\n");
          stop.abort();
        },
      },
    );
    expect(await code).toBe(0);
    expect(sink.out).toBe(
      `antibody relay: listening on http://127.0.0.1:${port}, holding 0 fixes in relay.json\nantibody relay: stopped, holding 0 fixes\n`,
    );
  });

  it("stops at once on a signal already given", async () => {
    const stop = new AbortController();
    stop.abort();
    const sink = io();
    expect(
      await main(["relay", "serve", "--port", "0"], sink, {
        cwd: dir,
        signal: stop.signal,
      }),
    ).toBe(0);
    expect(sink.out).toContain("holding 0 fixes in antibody-relay.json");
  });

  it.each([
    [[], "relay needs a command"],
    [["publish"], "unknown relay command: publish"],
    [["serve", "--port"], "unknown or incomplete option: --port"],
    [["serve", "--colour", "red"], "unknown or incomplete option: --colour"],
    [["serve", "--port", "99999"], "--port takes a port number"],
  ])("refuses %j", async (args, message) => {
    const sink = io();
    expect(await runRelay(args, sink, { cwd: dir })).toBe(2);
    expect(sink.err).toContain(message);
  });

  it("will not serve without a long enough token, or on a state that is not one", async () => {
    const sink = io({});
    expect(await runRelay(["serve"], sink, { cwd: dir })).toBe(1);
    expect(sink.err).toContain("set ANTIBODY_RELAY_TOKEN");
    writeFileSync(join(dir, "antibody-relay.json"), "{");
    const bad = io();
    expect(await runRelay(["serve", "--port", "0"], bad, { cwd: dir })).toBe(1);
    expect(bad.err).toContain("the relay could not start");
  });

  it("stops on SIGINT or SIGTERM", () => {
    for (const name of ["SIGINT", "SIGTERM"]) {
      const process = new EventEmitter();
      const signal = interrupted(process);
      expect(signal.aborted).toBe(false);
      process.emit(name);
      expect(signal.aborted).toBe(true);
    }
  });
});
