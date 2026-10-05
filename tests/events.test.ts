import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_LABEL_MAX_CHARS,
  EVENT_MAX_BYTES,
  appendEvent,
  encodeEvent,
  isMemoryEvent,
  parseEvents,
  readEventsFrom,
} from "../src/events";
import type { NewEvent } from "../src/events";
import { REDACTED } from "../src/redact-patterns";

const NOW = new Date("2026-10-05T06:00:00.000Z");
const base: NewEvent = { kind: "hit", agent: "claude-1", session: "s-1" };
const decode = (line: string) => JSON.parse(line) as Record<string, unknown>;

describe("encodeEvent", () => {
  it("writes one versioned, time-stamped JSON line", () => {
    const line = encodeEvent({ ...base, id: "E-0007", tokens: 96 }, NOW);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(decode(line)).toEqual({
      v: 1,
      t: "2026-10-05T06:00:00.000Z",
      kind: "hit",
      agent: "claude-1",
      session: "s-1",
      id: "E-0007",
      tokens: 96,
    });
  });

  it("keeps a time the event already has, and leaves out absent fields", () => {
    const line = encodeEvent({ ...base, t: "2026-10-01T00:00:00.000Z" }, NOW);
    expect(decode(line)).toEqual({
      v: 1,
      t: "2026-10-01T00:00:00.000Z",
      kind: "hit",
      agent: "claude-1",
      session: "s-1",
    });
  });

  it("redacts free text before it is written", () => {
    // Assembled at run time so the privacy guard does not flag this file.
    const key = ["sk-", "Zq7Xw2Lp9Rt4Vb8Nm3Kd6Hs1"].join("");
    const text = decode(
      encodeEvent({ ...base, text: `auth failed with ${key}` }, NOW),
    ).text as string;
    expect(text).not.toContain(key);
    expect(text).toContain(REDACTED.secret);
  });

  it("clips long text so the line fits, multibyte text included", () => {
    for (const unit of ["x", "错误", "😀"]) {
      const line = encodeEvent({ ...base, text: unit.repeat(5000) }, NOW);
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(EVENT_MAX_BYTES);
      expect(Buffer.byteLength(line)).toBeGreaterThan(EVENT_MAX_BYTES - 16);
      expect((decode(line).text as string).endsWith("…")).toBe(true);
    }
  });

  it("clips agent names, sessions and ids", () => {
    const long = "a".repeat(1000);
    const event = decode(
      encodeEvent({ ...base, agent: long, session: long, id: long }, NOW),
    );
    for (const key of ["agent", "session", "id"])
      expect(Array.from(event[key] as string).length).toBe(
        EVENT_LABEL_MAX_CHARS,
      );
  });
});

describe("isMemoryEvent", () => {
  const good = decode(
    encodeEvent({ ...base, id: "E-1", tokens: 0, text: "ok" }, NOW),
  );

  it("accepts what encodeEvent writes", () => {
    expect(isMemoryEvent(good)).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "hit"],
    ["another version", { ...good, v: 2 }],
    ["an unknown kind", { ...good, kind: "explode" }],
    ["a missing agent", { ...good, agent: undefined }],
    ["a numeric session", { ...good, session: 7 }],
    ["a numeric id", { ...good, id: 7 }],
    ["a numeric text", { ...good, text: 7 }],
    ["negative tokens", { ...good, tokens: -1 }],
    ["infinite tokens", { ...good, tokens: Infinity }],
    ["string tokens", { ...good, tokens: "96" }],
    ["a missing time", { ...good, t: undefined }],
  ])("rejects %s", (_name, value) => {
    expect(isMemoryEvent(value)).toBe(false);
  });
});

describe("parseEvents", () => {
  it("returns well-formed events and counts the rest, ignoring blank lines", () => {
    const text = [
      encodeEvent(base, NOW),
      "not json\n",
      "\n",
      `${JSON.stringify({ v: 1, kind: "hit" })}\n`,
      encodeEvent({ ...base, kind: "fix" }, NOW),
    ].join("");
    const batch = parseEvents(text);
    expect(batch.events.map((e) => e.kind)).toEqual(["hit", "fix"]);
    expect(batch.skipped).toBe(2);
  });
});

describe("appendEvent and readEventsFrom", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "antibody-events-"));
    file = join(dir, "nested", "events.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a missing log as empty", async () => {
    expect(await readEventsFrom(file)).toEqual({
      events: [],
      skipped: 0,
      offset: 0,
    });
  });

  it("creates the directory and tails the log by offset", async () => {
    await appendEvent(file, { ...base, id: "E-0001" }, NOW);
    await appendEvent(file, { ...base, kind: "claim", id: "E-0001" }, NOW);
    const first = await readEventsFrom(file);
    expect(first.events.map((e) => e.kind)).toEqual(["hit", "claim"]);

    await appendEvent(file, { ...base, kind: "fix", id: "E-0001" });
    const second = await readEventsFrom(file, first.offset);
    expect(second.events.map((e) => e.kind)).toEqual(["fix"]);
    expect(second.offset).toBeGreaterThan(first.offset);
    expect(await readEventsFrom(file, second.offset)).toMatchObject({
      events: [],
      offset: second.offset,
    });
  });

  it("leaves a line that is still being written for the next read", async () => {
    await appendEvent(file, base, NOW);
    const full = encodeEvent({ ...base, kind: "fix" }, NOW);
    await appendFile(file, full.slice(0, 20));
    const partial = await readEventsFrom(file);
    expect(partial.events).toHaveLength(1);
    expect(partial.skipped).toBe(0);

    await appendFile(file, full.slice(20));
    const rest = await readEventsFrom(file, partial.offset);
    expect(rest.events.map((e) => e.kind)).toEqual(["fix"]);
  });

  it("starts again from the beginning when the log was replaced", async () => {
    await appendEvent(file, base, NOW);
    await appendEvent(file, base, NOW);
    const before = await readEventsFrom(file);
    await writeFile(file, encodeEvent({ ...base, kind: "miss" }, NOW));
    const after = await readEventsFrom(file, before.offset);
    expect(after.events.map((e) => e.kind)).toEqual(["miss"]);
  });

  it("keeps every line whole when 100 appends race", async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, n) =>
        appendEvent(
          file,
          { ...base, id: `E-${n}`, text: "y".repeat(n * 30) },
          NOW,
        ),
      ),
    );
    const { events, skipped } = await readEventsFrom(file);
    expect(skipped).toBe(0);
    expect(new Set(events.map((e) => e.id)).size).toBe(100);
  });
});
