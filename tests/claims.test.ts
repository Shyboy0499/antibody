import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAIM_TTL_MS,
  activeClaim,
  claim,
  createClaimsFile,
  emptyClaims,
  parseClaims,
  pruneExpired,
  release,
  releaseSession,
  renderClaims,
} from "../src/claims";
import { filesIn } from "../src/paths";
import { nodeStoreFs } from "../src/store";
import type { StoreClock } from "../src/store";

const T0 = new Date("2026-10-05T06:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const a = { id: "E-0007", agent: "claude-1", session: "s-a" };
const b = { id: "E-0007", agent: "codex-2", session: "s-b" };

describe("claim decisions", () => {
  it("grants a free entry for the time to live", () => {
    const state = emptyClaims();
    const outcome = claim(state, a, T0);
    expect(outcome).toEqual({
      granted: true,
      claim: {
        ...a,
        since: T0.toISOString(),
        expires: later(CLAIM_TTL_MS).toISOString(),
      },
    });
    expect(activeClaim(state, "E-0007", T0)).toEqual(state.claims["E-0007"]);
  });

  it("refuses another session while the claim is live, naming the holder", () => {
    const state = emptyClaims();
    claim(state, a, T0);
    const outcome = claim(state, b, later(1000));
    expect(outcome.granted).toBe(false);
    expect(outcome.granted ? undefined : outcome.holder.agent).toBe("claude-1");
  });

  it("renews the holder's own claim, keeping when it began", () => {
    const state = emptyClaims();
    claim(state, a, T0);
    const renewed = claim(state, a, later(60_000), 1000);
    expect(renewed).toMatchObject({
      granted: true,
      claim: { since: T0.toISOString(), expires: later(61_000).toISOString() },
    });
  });

  it("lets anyone take over a claim whose time ran out", () => {
    const state = emptyClaims();
    claim(state, a, T0, 1000);
    expect(activeClaim(state, "E-0007", later(1000))).toBeUndefined();
    expect(claim(state, b, later(1000))).toMatchObject({
      granted: true,
      claim: { agent: "codex-2", since: later(1000).toISOString() },
    });
  });

  it("releases only for the holder's session, or for anyone without one", () => {
    const state = emptyClaims();
    claim(state, a, T0);
    expect(release(state, "E-0007", "s-b")).toBe(false);
    expect(release(state, "E-0007", "s-a")).toBe(true);
    expect(release(state, "E-0007")).toBe(false);
    claim(state, a, T0);
    expect(release(state, "E-0007")).toBe(true);
  });

  it("releases every claim of an ending session", () => {
    const state = emptyClaims();
    claim(state, a, T0);
    claim(state, { ...a, id: "E-0008" }, T0);
    claim(state, { ...b, id: "E-0009" }, T0);
    expect(releaseSession(state, "s-a").sort()).toEqual(["E-0007", "E-0008"]);
    expect(Object.keys(state.claims)).toEqual(["E-0009"]);
  });

  it("prunes expired claims and reports them", () => {
    const state = emptyClaims();
    claim(state, a, T0, 1000);
    claim(state, { ...b, id: "E-0009" }, T0, 5000);
    expect(pruneExpired(state, later(2000))).toEqual(["E-0007"]);
    expect(Object.keys(state.claims)).toEqual(["E-0009"]);
  });
});

describe("claims.json format", () => {
  it("round-trips through render and parse", () => {
    const state = emptyClaims();
    claim(state, a, T0);
    expect(parseClaims(renderClaims(state))).toEqual(state);
  });

  it.each([
    ["not JSON", "{"],
    ["JSON that is not an object", "7"],
    ["another version", JSON.stringify({ version: 2, claims: {} })],
  ])("reads %s as unreadable", (_name, text) => {
    expect(parseClaims(text)).toBeUndefined();
  });

  it("drops a malformed record on its own", () => {
    const good = {
      ...a,
      since: T0.toISOString(),
      expires: later(1000).toISOString(),
    };
    const text = JSON.stringify({
      version: 1,
      claims: {
        "E-0007": good,
        "E-0008": { ...good, id: "E-0099" },
        "E-0009": { ...good, id: "E-0009", expires: "soon" },
        "E-0010": null,
      },
    });
    expect(Object.keys(parseClaims(text)!.claims)).toEqual(["E-0007"]);
    expect(parseClaims(JSON.stringify({ version: 1 }))).toEqual(emptyClaims());
  });
});

describe("createClaimsFile", () => {
  let dir: string;
  let now: Date;
  const clock: StoreClock = {
    now: () => now,
    sleep: (ms) =>
      new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    random: Math.random,
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "antibody-claims-"));
    now = T0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const files = () => filesIn(join(dir, "memory"));

  it("reads a missing file as empty and creates the directory on first claim", async () => {
    const claims = createClaimsFile(files(), {}, nodeStoreFs(), clock);
    expect(await claims.read()).toEqual(emptyClaims());
    expect((await claims.claim(a)).granted).toBe(true);
    expect(
      parseClaims(await readFile(files().claims, "utf8"))!.claims["E-0007"]
        ?.agent,
    ).toBe("claude-1");
  });

  it("gives exactly one of 20 racing agents the claim", async () => {
    const claims = createClaimsFile(files(), {}, nodeStoreFs(), clock);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        claims.claim({ id: "E-0007", agent: `agent-${n}`, session: `s-${n}` }),
      ),
    );
    const winners = outcomes.filter((o) => o.granted);
    expect(winners).toHaveLength(1);
    const holder = winners[0]!.granted ? winners[0]!.claim.agent : "";
    for (const o of outcomes)
      if (!o.granted) expect(o.holder.agent).toBe(holder);
  });

  it("lets a claim lapse after its time to live", async () => {
    const claims = createClaimsFile(
      files(),
      { ttlMs: 1000 },
      nodeStoreFs(),
      clock,
    );
    await claims.claim(a);
    now = later(999);
    expect((await claims.claim(b)).granted).toBe(false);
    now = later(1000);
    expect((await claims.claim(b)).granted).toBe(true);
  });

  it("releases by entry and by session", async () => {
    const claims = createClaimsFile(files(), {}, nodeStoreFs(), clock);
    await claims.claim(a);
    await claims.claim({ ...a, id: "E-0008" });
    expect(await claims.release("E-0007", "s-b")).toBe(false);
    expect(await claims.release("E-0007")).toBe(true);
    expect(await claims.releaseSession("s-a")).toEqual(["E-0008"]);
    expect((await claims.read()).claims).toEqual({});
  });

  it("treats an unreadable file as empty and replaces it", async () => {
    const claims = createClaimsFile(files(), {}, nodeStoreFs(), clock);
    await claims.claim(a);
    await writeFile(files().claims, "not json");
    expect(await claims.read()).toEqual(emptyClaims());
    expect((await claims.claim(b)).granted).toBe(true);
    expect(parseClaims(await readFile(files().claims, "utf8"))).toBeDefined();
  });
});
