import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSIONS_DIR_NAME,
  createSessionFile,
  freshSession,
  parseSession,
  sessionFileName,
} from "../src/session";

describe("sessionFileName", () => {
  it("keeps a plain session id", () => {
    expect(sessionFileName("3f6c1a2e-9b7d-4c1e-8f00-1234abcd5678")).toBe(
      "3f6c1a2e-9b7d-4c1e-8f00-1234abcd5678.json",
    );
  });

  it("hashes anything that could name another path", () => {
    for (const id of [
      "../../etc/passwd",
      "a/b",
      "x".repeat(101),
      "",
      "naïve",
    ]) {
      const name = sessionFileName(id);
      expect(name).toMatch(/^[0-9a-f]{32}\.json$/);
    }
    expect(sessionFileName("a/b")).not.toBe(sessionFileName("a\\b"));
  });
});

describe("parseSession", () => {
  it("round-trips a session's state", () => {
    const state = {
      ...freshSession("s-1"),
      trustTurn: ["E-1"],
      holding: ["E-2"],
    };
    expect(parseSession(JSON.stringify(state), "s-1")).toEqual(state);
  });

  it.each([
    ["not JSON", "{"],
    ["JSON that is not an object", "null"],
    ["another version", JSON.stringify({ ...freshSession("s-1"), version: 2 })],
    ["another session's file", JSON.stringify(freshSession("s-2"))],
  ])("reads %s as nothing", (_name, text) => {
    expect(parseSession(text, "s-1")).toBeUndefined();
  });

  it("replaces malformed parts with fresh ones", () => {
    const text = JSON.stringify({
      version: 1,
      session: "s-1",
      caps: [],
      resolution: "x",
      trustTurn: ["E-1", 2],
      holding: "E-3",
    });
    expect(parseSession(text, "s-1")).toEqual({
      ...freshSession("s-1"),
      trustTurn: ["E-1"],
    });
  });
});

describe("createSessionFile", () => {
  let memory: string;

  beforeEach(async () => {
    memory = join(await mkdtemp(join(tmpdir(), "antibody-session-")), "memory");
  });

  afterEach(async () => {
    await rm(join(memory, ".."), { recursive: true, force: true });
  });

  it("reads a missing file as a fresh session", async () => {
    expect(await createSessionFile(memory, "s-1").read()).toEqual(
      freshSession("s-1"),
    );
  });

  it("keeps changes for the next process", async () => {
    const file = createSessionFile(memory, "s-1");
    const result = await file.update((s) => {
      s.holding.push("E-0007");
      return s.holding.length;
    });
    expect(result).toBe(1);
    expect((await createSessionFile(memory, "s-1").read()).holding).toEqual([
      "E-0007",
    ]);
    const [name] = await readdir(join(memory, SESSIONS_DIR_NAME));
    expect(name).toBe("s-1.json");
  });

  it("loses no change when parallel hooks update at once", async () => {
    const file = createSessionFile(memory, "s-1");
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        file.update((s) => void s.holding.push(`E-${n}`)),
      ),
    );
    expect((await file.read()).holding).toHaveLength(20);
  });

  it("treats an unreadable file as fresh, and forgets a session on remove", async () => {
    const file = createSessionFile(memory, "s-1");
    await file.update((s) => void s.trustTurn.push("E-1"));
    const path = join(memory, SESSIONS_DIR_NAME, "s-1.json");
    await writeFile(path, "garbage");
    expect(await file.read()).toEqual(freshSession("s-1"));
    await file.update(() => undefined);
    expect(JSON.parse(await readFile(path, "utf8")).session).toBe("s-1");
    await file.remove();
    expect(await readdir(join(memory, SESSIONS_DIR_NAME))).toEqual([]);
    await file.remove();
  });
});
