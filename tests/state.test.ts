// Ported from dsh-errkb, tests/state.test.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesIn } from "../src/paths";
import {
  STATE_VERSION,
  addHit,
  corruptStateFileName,
  createStateFile,
  effectiveEntry,
  emptyState,
  laterSeen,
  parseState,
  renderState,
} from "../src/state";
import type { MachineState } from "../src/state";
import { LockTimeoutError, parseDocument, renderEntry } from "../src/store";
import type { Entry } from "../src/store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "errkb-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TRUST = {
  injected: 2,
  recurredAfterInject: 1,
  succeeded: 0,
  fixSig: "abc",
};

const sample = (): MachineState => ({
  version: 1,
  entries: { "E-0007": { hits: 3, lastSeen: "2026-09-14 09:12" } },
  trust: { "E-0007": { ...TRUST } },
});

function entry(over: Partial<Entry> = {}): Entry {
  const text = renderEntry({
    id: "E-0007",
    title: "[tool:bash] boom",
    meta: { sig: "0123456789ab" },
    fingerprint: "0123456789ab",
    category: "tool / bash",
    firstSeen: "2026-09-01 10:00",
    lastSeen: "2026-09-10 10:00",
    hits: 4,
    trigger: "",
    raw: "boom",
    fix: "",
    status: "open",
    notes: "",
  });
  return { ...(parseDocument(text).blocks[0]?.entry as Entry), ...over };
}

// ---------------------------------------------------------------------------
// The pure part

describe("parseState / renderState", () => {
  it("round-trips a state", () => {
    const text = renderState(sample());
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseState(text)).toEqual(sample());
  });

  it("missing maps read as empty", () => {
    expect(parseState('{"version":1}')).toEqual(emptyState());
    expect(emptyState()).toEqual({
      version: STATE_VERSION,
      entries: {},
      trust: {},
    });
  });

  it("anything that is not a version-1 object is unreadable", () => {
    for (const text of [
      "",
      "{",
      "null",
      "[]",
      '"text"',
      "{}",
      '{"version":2,"entries":{}}',
      '{"version":"1"}',
      '{"version":1,"entries":[]}',
      '{"version":1,"entries":null}',
      '{"version":1,"trust":3}',
    ])
      expect(parseState(text), text).toBeUndefined();
  });

  it("a malformed record is dropped on its own; extra fields are not kept", () => {
    const state = parseState(
      JSON.stringify({
        version: 1,
        entries: {
          "E-0001": { hits: 2, lastSeen: "x", extra: true },
          "E-0002": { hits: -1, lastSeen: "x" },
          "E-0003": { hits: 1.5, lastSeen: "x" },
          "E-0004": { hits: 1 },
          "E-0005": "nope",
        },
        trust: {
          "E-0001": { ...TRUST, extra: 1 },
          "E-0002": { ...TRUST, fixSig: 7 },
          "E-0003": { ...TRUST, succeeded: "1" },
        },
      }),
    );
    expect(state).toEqual({
      version: 1,
      entries: { "E-0001": { hits: 2, lastSeen: "x" } },
      trust: { "E-0001": TRUST },
    });
  });

  it("a __proto__ key is an ordinary ID, not a prototype", () => {
    const state = parseState(
      '{"version":1,"entries":{"__proto__":{"hits":1,"lastSeen":"x"}}}',
    ) as MachineState;
    expect(Object.getPrototypeOf(state.entries)).toBe(Object.prototype);
    expect(Object.keys(state.entries)).toEqual(["__proto__"]);
  });
});

describe("effectiveEntry / laterSeen / addHit", () => {
  it("without a counter the entry is its baseline", () => {
    const e = entry();
    expect(effectiveEntry(e, undefined)).toBe(e);
  });

  it("hits add up; last seen is the later of the two", () => {
    const e = entry();
    expect(
      effectiveEntry(e, { hits: 3, lastSeen: "2026-09-14 09:12" }),
    ).toEqual({ ...e, hits: 7, lastSeen: "2026-09-14 09:12" });
    // A block edited later than this machine last saw it keeps its time.
    expect(
      effectiveEntry(e, { hits: 1, lastSeen: "2026-09-01 00:00" }).lastSeen,
    ).toBe("2026-09-10 10:00");
  });

  it("laterSeen: the later text wins and an empty one loses", () => {
    expect(laterSeen("2026-09-01 10:00", "2026-09-02 09:00")).toBe(
      "2026-09-02 09:00",
    );
    expect(laterSeen("2026-09-02 09:00", "2026-09-01 10:00")).toBe(
      "2026-09-02 09:00",
    );
    expect(laterSeen("", "2026-09-01 10:00")).toBe("2026-09-01 10:00");
    expect(laterSeen("2026-09-01 10:00", "")).toBe("2026-09-01 10:00");
  });

  it("addHit starts a counter, then counts on it", () => {
    const state = emptyState();
    expect(addHit(state, "E-0001", "2026-09-01 10:00")).toEqual({
      hits: 1,
      lastSeen: "2026-09-01 10:00",
    });
    expect(addHit(state, "E-0001", "2026-09-01 11:00")).toEqual({
      hits: 2,
      lastSeen: "2026-09-01 11:00",
    });
    expect(state.entries).toEqual({
      "E-0001": { hits: 2, lastSeen: "2026-09-01 11:00" },
    });
  });

  it("names a corrupt copy legally on every platform", () => {
    expect(corruptStateFileName(new Date(Date.UTC(2026, 9, 1, 8, 0, 0)))).toBe(
      "state.corrupt-2026-10-01T08-00-00-000Z.json",
    );
  });
});

// ---------------------------------------------------------------------------
// The file

describe("createStateFile", () => {
  const files = () => filesIn(dir);
  const corruptCopies = async () =>
    (await readdir(dir)).filter((n) => n.startsWith("state.corrupt-")).sort();

  it("a missing file is an empty state", async () => {
    expect(await createStateFile(files()).read()).toEqual({
      state: emptyState(),
      corrupt: false,
    });
  });

  it("update writes the file atomically and leaves no lock or temp file", async () => {
    const state = createStateFile(files());
    const written = await state.update((s) => {
      addHit(s, "E-0001", "2026-09-01 10:00");
    });
    expect(written).toEqual({
      state: {
        version: 1,
        entries: { "E-0001": { hits: 1, lastSeen: "2026-09-01 10:00" } },
        trust: {},
      },
    });
    expect(await readFile(files().state, "utf8")).toBe(
      renderState(written.state),
    );
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect((await state.read()).state).toEqual(written.state);
  });

  for (const [what, text] of [
    ["unparseable JSON", "{ not json"],
    ["a wrong version", '{"version":9,"entries":{}}'],
  ] as const)
    it(`${what}: reads as empty without touching the file; the next write saves it aside once`, async () => {
      await writeFile(files().state, text);
      const state = createStateFile(files(), {}, undefined, {
        now: () => new Date(Date.UTC(2026, 9, 1, 8, 0, 0)),
        sleep: async () => undefined,
        random: () => 0.5,
      });
      expect(await state.read()).toEqual({
        state: emptyState(),
        corrupt: true,
      });
      expect(await readFile(files().state, "utf8")).toBe(text);
      expect(await corruptCopies()).toEqual([]);

      const written = await state.update((s) => {
        addHit(s, "E-0001", "2026-10-01 08:00");
      });
      expect(written.savedAs).toBe(
        "state.corrupt-2026-10-01T08-00-00-000Z.json",
      );
      expect(await readFile(join(dir, written.savedAs as string), "utf8")).toBe(
        text,
      );
      expect((await state.read()).state.entries).toEqual({
        "E-0001": { hits: 1, lastSeen: "2026-10-01 08:00" },
      });

      // The same corruption again is not copied twice.
      await writeFile(files().state, text);
      expect((await state.update(() => undefined)).savedAs).toBeUndefined();
      expect(await corruptCopies()).toHaveLength(1);
    });

  it("a different corruption gets its own copy", async () => {
    let t = Date.UTC(2026, 9, 1, 8, 0, 0);
    const clock = {
      now: () => new Date((t += 1000)),
      sleep: async () => undefined,
      random: () => 0.5,
    };
    const state = createStateFile(files(), {}, undefined, clock);
    await writeFile(files().state, "one");
    await state.update(() => undefined);
    await writeFile(files().state, "two");
    await state.update(() => undefined);
    expect(await corruptCopies()).toHaveLength(2);
  });

  it("takes the knowledge base's .lock: a fresh lock held elsewhere times out", async () => {
    await writeFile(files().lock, "someone-else");
    const state = createStateFile(files(), { lockTimeoutMs: 0 });
    await expect(state.update(() => undefined)).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    await expect(readFile(files().state, "utf8")).rejects.toThrow();
  });

  it("a stale lock is taken over", async () => {
    await writeFile(files().lock, "crashed");
    const old = new Date(Date.now() - 60_000);
    await utimes(files().lock, old, old);
    await createStateFile(files()).update((s) => {
      addHit(s, "E-0001", "x");
    });
    expect((await readdir(dir)).sort()).toEqual(["state.json"]);
  });

  it("concurrent updates from separate handles, as two processes would make, lose no increment", async () => {
    const n = 25;
    await Promise.all(
      Array.from({ length: n }, () =>
        createStateFile(files()).update((s) => {
          addHit(s, "E-0001", "2026-10-01 08:00");
        }),
      ),
    );
    const { state } = await createStateFile(files()).read();
    expect(state.entries["E-0001"]?.hits).toBe(n);
  });
});
