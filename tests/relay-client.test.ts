// Two machines' memories syncing through a real relay: what is pushed, what
// is pulled and how it is held, what is not sent twice, how a sync fails, and
// `antibody relay sync`.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureInput } from "../src/capture";
import type { CliIo } from "../src/cli";
import { createFleet } from "../src/fleet";
import { filesIn, memoryDir } from "../src/paths";
import { runRelay } from "../src/relay-cli";
import { RELAY_STATE_FILE, relayConfig, syncRelay } from "../src/relay-client";
import type { RelayConfig, SyncResult } from "../src/relay-client";
import { startRelay } from "../src/relay-server";
import type { RelayServer } from "../src/relay-server";
import type { ToolCall } from "../src/resolve-detect";
import { parseDocument } from "../src/store";

const TOKEN = "a-relay-token-long-enough";
const ENOENT = "ENOENT: no such file or directory, open '.env'";
const EACCES = "EACCES: permission denied, open 'deploy.key'";
const FIX = "Copy .env from the main checkout.";

let root: string;
let shop: string;
let laptop: string;
let relay: RelayServer;
let url: string;

const failure = (message: string) =>
  [
    { kind: "tool", toolName: "Read", isError: true, message } as CaptureInput,
    { toolName: "Read", isError: true, text: message } as ToolCall,
  ] as const;

/** An agent in `repo` meets an error, and, given a fix, records it. */
async function meet(repo: string, message: string, fix?: string) {
  const fleet = createFleet(memoryDir(repo), "claude-code@x", "s-1");
  const told = await fleet.failure(...failure(message));
  if (fix !== undefined) {
    const id = entries(repo).find(
      (e) => e.fix === "" && e.raw.includes(message.slice(0, 6)),
    )?.id;
    await fleet.recordFix(id as string, fix);
  }
  return told;
}

const entries = (repo: string) => {
  const file = filesIn(memoryDir(repo)).errors;
  return existsSync(file)
    ? parseDocument(readFileSync(file, "utf8")).blocks.map((b) => b.entry)
    : [];
};

const config = (trust: RelayConfig["trust"] = "review"): RelayConfig => ({
  url,
  token: TOKEN,
  trust,
});
/** A sync that should work. */
const sync = async (repo: string, c = config()): Promise<SyncResult> => {
  const result = await syncRelay(memoryDir(repo), c);
  if ("error" in result) throw new Error(result.error);
  return result;
};

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-sync-")));
  shop = join(root, "shop");
  laptop = join(root, "laptop");
  for (const dir of [shop, laptop]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
  relay = await startRelay({
    token: TOKEN,
    dataFile: join(root, "relay.json"),
    port: 0,
    host: "127.0.0.1",
  });
  url = `http://127.0.0.1:${relay.port}`;
});

afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe("syncRelay", () => {
  it("pushes one machine's fix, and another pulls it, held for review", async () => {
    await meet(shop, ENOENT, FIX);
    expect(await sync(shop)).toEqual({ pushed: 1, pulled: 0, held: true });
    expect(await sync(laptop)).toEqual({ pushed: 0, pulled: 1, held: true });
    expect(entries(laptop).map((e) => [e.fix, e.meta.review])).toEqual([
      [FIX, "fix+text"],
    ]);
    // An agent on the laptop is not given it before a person reviews it.
    expect((await meet(laptop, ENOENT)).join("")).not.toContain(FIX);
  });

  it("gives agents what it pulls at once from a relay trusted as the fleet's own", async () => {
    await meet(shop, ENOENT, FIX);
    await sync(shop);
    expect(await sync(laptop, config("fleet"))).toEqual({
      pushed: 0,
      pulled: 1,
      held: false,
    });
    expect(entries(laptop)[0]?.meta.review).toBeUndefined();
    expect((await meet(laptop, ENOENT)).join("")).toContain(FIX);
  });

  it("gives a trusted fix to an error this machine met and had no fix for", async () => {
    await meet(laptop, ENOENT);
    await meet(shop, ENOENT, FIX);
    await sync(shop);
    expect((await sync(laptop, config("fleet"))).pulled).toBe(1);
    expect(entries(laptop).map((e) => [e.fix, e.meta.review])).toEqual([
      [FIX, undefined],
    ]);
  });

  it("sends and takes only what changed, and does not push back what it pulled", async () => {
    await meet(shop, ENOENT, FIX);
    await sync(shop);
    await sync(laptop, config("fleet"));
    expect(await sync(shop)).toEqual({ pushed: 0, pulled: 0, held: true });
    expect(await sync(laptop, config("fleet"))).toEqual({
      pushed: 0,
      pulled: 0,
      held: false,
    });
    await meet(shop, EACCES, "chmod 600 deploy.key");
    expect((await sync(shop)).pushed).toBe(1);
    expect((await sync(laptop, config("fleet"))).pulled).toBe(1);
    expect(relay.fixes()).toBe(2);
  });

  it("starts over when it is pointed at another relay", async () => {
    await meet(shop, ENOENT, FIX);
    await sync(shop);
    await sync(laptop);
    writeFileSync(
      join(memoryDir(laptop), RELAY_STATE_FILE),
      JSON.stringify({ url: "https://elsewhere.example", seq: 9, known: {} }),
    );
    // The laptop already holds the fix, so nothing more comes in, but it asks
    // this relay from the start and pushes nothing it pulled.
    expect(await sync(laptop)).toEqual({ pushed: 0, pulled: 0, held: true });
    const state = JSON.parse(
      readFileSync(join(memoryDir(laptop), RELAY_STATE_FILE), "utf8"),
    );
    expect([state.url, state.seq]).toEqual([url, 1]);
  });

  it("reads a damaged sync record as a fresh one", async () => {
    await meet(shop, ENOENT, FIX);
    mkdirSync(memoryDir(shop), { recursive: true });
    for (const text of ["{", JSON.stringify({ url, seq: "x", known: {} })]) {
      writeFileSync(join(memoryDir(shop), RELAY_STATE_FILE), text);
      expect((await sync(shop)).pushed).toBe(1);
    }
  });

  it("fails with the relay's reason: a wrong token, a relay that is down, a bad document", async () => {
    await meet(shop, ENOENT, FIX);
    expect(
      await syncRelay(memoryDir(shop), { ...config(), token: "x".repeat(20) }),
    ).toEqual({ error: "the relay answered 401: a missing or wrong token" });
    const bad = await syncRelay(memoryDir(laptop), config(), {
      fetch: async () =>
        new Response(JSON.stringify({ seq: 1, document: "## E-1 · x\n" })),
    });
    expect("error" in bad && bad.error).toMatch(/could not read/);
    const plain = await syncRelay(memoryDir(laptop), config(), {
      fetch: async () => new Response("not json", { status: 502 }),
    });
    expect(plain).toEqual({ error: "the relay answered 502" });
    await relay.close();
    expect("error" in (await syncRelay(memoryDir(shop), config()))).toBe(true);
  });

  it("gives way to another sync of the same memory", async () => {
    mkdirSync(memoryDir(shop), { recursive: true });
    writeFileSync(join(memoryDir(shop), "relay.lock"), "held");
    const result = await syncRelay(memoryDir(shop), config());
    expect("error" in result && result.error).toMatch(/lock/);
  });
});

describe("relayConfig", () => {
  const env = (extra: NodeJS.ProcessEnv) => ({
    ANTIBODY_RELAY: "https://relay.example/",
    ANTIBODY_RELAY_TOKEN: TOKEN,
    ...extra,
  });

  it("is undefined when no relay is set", () => {
    expect(relayConfig({})).toBeUndefined();
    expect(relayConfig({ ANTIBODY_RELAY: " " })).toBeUndefined();
  });

  it("reads the URL, the token and the trust, review by default", () => {
    expect(relayConfig(env({}))).toEqual({
      url: "https://relay.example",
      token: TOKEN,
      trust: "review",
    });
    expect(relayConfig(env({ ANTIBODY_RELAY_TRUST: "fleet" }))).toMatchObject({
      trust: "fleet",
    });
  });

  it.each([
    [{ ANTIBODY_RELAY: "not a url" }, "is not a URL"],
    [{ ANTIBODY_RELAY: "ftp://relay.example" }, "http or https"],
    [{ ANTIBODY_RELAY_TOKEN: "short" }, "16 characters or more"],
    [{ ANTIBODY_RELAY_TRUST: "everyone" }, "takes review or fleet"],
  ])("says what is wrong with %j", (extra, message) => {
    const c = relayConfig(env(extra));
    expect(c !== undefined && "error" in c && c.error).toContain(message);
  });
});

describe("antibody relay sync", () => {
  const run = async (
    env: NodeJS.ProcessEnv,
    args: string[] = [],
    cwd = shop,
  ) => {
    const sink = {
      out: "",
      err: "",
      readStdin: async () => "",
      stdout: (t: string) => void (sink.out += t),
      stderr: (t: string) => void (sink.err += t),
      env,
    };
    const code = await runRelay(["sync", ...args], sink as CliIo, { cwd });
    return { code, out: sink.out, err: sink.err };
  };
  const relayEnv = (extra: NodeJS.ProcessEnv = {}) => ({
    ANTIBODY_RELAY: url,
    ANTIBODY_RELAY_TOKEN: TOKEN,
    ...extra,
  });

  it("says what it pushed and pulled, and how the pulled fixes are held", async () => {
    await meet(shop, ENOENT, FIX);
    await meet(shop, EACCES, "chmod 600 deploy.key");
    const host = new URL(url).host;
    expect((await run(relayEnv())).out).toBe(
      `Pushed 2 fixes to ${host}, and pulled 0 fixes.\n`,
    );
    expect((await run(relayEnv(), [], laptop)).out).toBe(
      `Pushed 0 fixes to ${host}, and pulled 2 fixes, held for your review: run \`antibody review\`.\n`,
    );
    rmSync(join(memoryDir(laptop), RELAY_STATE_FILE));
    await meet(shop, "TypeError: x is not a function", "Call it as a method.");
    await run(relayEnv());
    const trusted = await run(
      relayEnv({ ANTIBODY_RELAY_TRUST: "fleet" }),
      [],
      laptop,
    );
    expect(trusted.out).toBe(
      `Pushed 0 fixes to ${host}, and pulled 1 fix, given to agents as they meet the errors.\n`,
    );
  });

  it("wants a relay, a good configuration, a repository and no options", async () => {
    expect(await run({})).toMatchObject({ code: 1 });
    expect((await run({})).err).toContain("no relay is set");
    expect((await run(relayEnv({ ANTIBODY_RELAY_TOKEN: "x" }))).code).toBe(1);
    expect((await run(relayEnv(), [], root)).code).toBe(1);
    expect((await run(relayEnv(), ["--now"])).code).toBe(2);
  });

  it("fails with the relay's reason", async () => {
    await meet(shop, ENOENT, FIX);
    const wrong = await run(relayEnv({ ANTIBODY_RELAY_TOKEN: "y".repeat(20) }));
    expect(wrong.code).toBe(1);
    expect(wrong.err).toBe(
      "antibody: the relay sync failed: the relay answered 401: a missing or wrong token\n",
    );
  });
});
