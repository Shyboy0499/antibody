// Removing a fix from the relay: the owner's token alone removes it, the
// fingerprint is blocked from coming back, and what a machine is sent says what
// was removed since it last asked.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptFixes,
  emptyRelay,
  fixesSince,
  parseRelayState,
  removeFix,
} from "../src/relay";
import type { RelayState } from "../src/relay";
import { startRelay } from "../src/relay-server";
import type { RelayServer } from "../src/relay-server";
import { DOCUMENT_HEADER, renderEntry } from "../src/store";
import type { Entry } from "../src/store";

const MACHINE = "a-machine-token-long-enough";
const OWNER = "the-owners-token-long-enough";

const entry = (n: number): Entry => ({
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
  fix: `Fix number ${n}.`,
  status: "fixed",
  notes: "",
});

const doc = (...entries: Entry[]) =>
  `${DOCUMENT_HEADER}\n${entries.map((e) => renderEntry(e)).join("\n")}`;

const withFixes = (...ns: number[]): RelayState => {
  const result = acceptFixes(emptyRelay(), doc(...ns.map(entry)));
  if ("error" in result) throw new Error(result.error);
  return result.state;
};

describe("removeFix", () => {
  it("removes the fix, records the removal, and blocks the fingerprint", () => {
    const before = withFixes(1, 2);
    const { state, removed } = removeFix(before, "000000000001");
    expect(removed).toBe(true);
    expect(state.fixes.map((f) => f.entry.meta.sig)).toEqual(["000000000002"]);
    expect(state.removed).toEqual([
      { seq: before.seq + 1, key: "000000000001" },
    ]);
    expect(state.blocked).toEqual(["000000000001"]);
    // The state it was given is not changed.
    expect(before.fixes).toHaveLength(2);
  });

  it("blocks a fingerprint the relay does not hold, and says nothing was removed", () => {
    const { state, removed } = removeFix(withFixes(1), "ffffffffffff");
    expect(removed).toBe(false);
    expect(state.blocked).toEqual(["ffffffffffff"]);
    expect(state.removed).toEqual([]);
  });

  it("ignores a push of a blocked fingerprint, and takes the others", () => {
    const { state } = removeFix(withFixes(1), "000000000001");
    const result = acceptFixes(state, doc(entry(1), entry(2)));
    if ("error" in result) throw new Error(result.error);
    expect(result.accepted).toBe(1);
    expect(result.ignored).toBe(1);
    expect(result.state.fixes.map((f) => f.entry.meta.sig)).toEqual([
      "000000000002",
    ]);
  });
});

describe("what a machine is sent about removals", () => {
  it("lists the fingerprints removed after the machine last asked", () => {
    const first = withFixes(1, 2);
    const { state: removedOne } = removeFix(first, "000000000001");
    const { state: removedTwo } = removeFix(removedOne, "000000000002");
    expect(fixesSince(removedTwo, 0).removed).toEqual([
      "000000000001",
      "000000000002",
    ]);
    expect(fixesSince(removedTwo, removedOne.seq).removed).toEqual([
      "000000000002",
    ]);
    expect(fixesSince(removedTwo, removedTwo.seq).removed).toEqual([]);
  });
});

describe("saving removals", () => {
  it("reads a state saved before removals existed as having none", () => {
    const old = JSON.stringify({ version: 1, seq: 0, fixes: [] });
    expect(parseRelayState(old)).toEqual({
      version: 1,
      seq: 0,
      fixes: [],
      removed: [],
      blocked: [],
    });
  });

  it("round-trips removals and blocks, and refuses a malformed key", () => {
    const { state } = removeFix(withFixes(1), "000000000001");
    expect(parseRelayState(JSON.stringify(state))).toEqual(state);
    const bad = JSON.stringify({ ...state, blocked: ["not-a-fingerprint"] });
    expect(parseRelayState(bad)).toBeUndefined();
  });
});

describe("DELETE /v1/fixes/<fingerprint>", () => {
  let dir: string;
  let data: string;
  let relay: RelayServer | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "antibody-remove-"));
    data = join(dir, "relay.json");
  });

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async () => {
    relay = await startRelay({
      tokens: [MACHINE],
      adminToken: OWNER,
      dataFile: data,
      port: 0,
      host: "127.0.0.1",
    });
    return relay;
  };
  const request = async (path: string, init: RequestInit, token?: string) => {
    const res = await fetch(`http://127.0.0.1:${relay?.port}${path}`, {
      ...init,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  const push = (document: string) =>
    request(
      "/v1/fixes",
      { method: "POST", body: JSON.stringify({ document }) },
      MACHINE,
    );

  it("removes a fix for the owner, and the machines see it removed", async () => {
    await start();
    expect((await push(doc(entry(1)))).body.accepted).toBe(1);
    const gone = await request(
      "/v1/fixes/000000000001",
      { method: "DELETE" },
      OWNER,
    );
    expect(gone.status).toBe(200);
    expect(gone.body.removed).toBe(true);
    const pulled = await request(
      "/v1/fixes?since=0",
      { method: "GET" },
      MACHINE,
    );
    expect(pulled.body.count).toBe(0);
    expect(pulled.body.removed).toEqual(["000000000001"]);
  });

  it("refuses a machine's token, and an unknown one", async () => {
    await start();
    const machine = await request(
      "/v1/fixes/000000000001",
      { method: "DELETE" },
      MACHINE,
    );
    expect(machine.status).toBe(403);
    expect(machine.body.error).toContain("owner's token");
    const stranger = await request(
      "/v1/fixes/000000000001",
      { method: "DELETE" },
      "not-a-listed-token-1",
    );
    expect(stranger.status).toBe(401);
  });

  it("takes a fingerprint of twelve hex digits, and the DELETE method", async () => {
    await start();
    const bad = await request("/v1/fixes/nope", { method: "DELETE" }, OWNER);
    expect(bad.status).toBe(400);
    const wrongMethod = await request(
      "/v1/fixes/000000000001",
      { method: "GET" },
      OWNER,
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("is refused by a relay started without an admin token", async () => {
    relay = await startRelay({
      tokens: [MACHINE],
      dataFile: data,
      port: 0,
      host: "127.0.0.1",
    });
    const attempt = await request(
      "/v1/fixes/000000000001",
      { method: "DELETE" },
      OWNER,
    );
    expect(attempt.status).toBe(401);
  });

  it("keeps the removal across a restart", async () => {
    writeFileSync(
      data,
      JSON.stringify(removeFix(withFixes(1), "000000000001").state),
    );
    await start();
    const pulled = await request(
      "/v1/fixes?since=0",
      { method: "GET" },
      MACHINE,
    );
    expect(pulled.body.count).toBe(0);
    expect(pulled.body.removed).toEqual(["000000000001"]);
  });
});
