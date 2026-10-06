// Ported from dsh-errkb, tests/store.test.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesIn } from "../src/paths";
import {
  ARCHIVE_HEADER,
  DOCUMENT_HEADER,
  LABELS,
  LockTimeoutError,
  ParseError,
  StoreCorruptError,
  createStore,
  decodeMetaValue,
  detectLabels,
  encodeMetaValue,
  formatFirst,
  formatId,
  formatSeen,
  nextIdNumber,
  nodeStoreFs,
  parseDocument,
  renderDocument,
  renderEntry,
  scanIdNumbers,
  systemClock,
} from "../src/store";
import type { Entry, NewEntry, StoreClock, StoreFs } from "../src/store";

// ---------------------------------------------------------------------------
// Fixtures

/** A complete entry; tests override what they care about. */
function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "E-0007",
    title: "[tool:pwsh] EPERM: operation not permitted, rename",
    meta: {
      sig: "3f2a1c9d0b71",
      cat: "tool",
      code: "EPERM",
      first: "2026-09-14T09:12:33Z",
    },
    fingerprint: "3f2a1c9d0b71",
    category: "tool / pwsh",
    firstSeen: "2026-09-14 09:12",
    lastSeen: "2026-09-14 15:40",
    hits: 5,
    trigger: "`pnpm install` writing `node_modules`",
    raw: "EPERM: operation not permitted, rename '<path>\\node_modules\\.pnpm\\<hash>'",
    fix: "Close the editor that holds the directory, then re-run `pnpm install`.\nIf it persists, use `pnpm install --config.node-linker=hoisted`.",
    status: "fixed",
    notes: "",
    ...overrides,
  };
}

/** The §8 sample of the design document, Chinese labels, verbatim. */
const DESIGN_SAMPLE = [
  "## E-0007 · [tool:pwsh] EPERM: operation not permitted, rename",
  "<!-- antibody: sig=3f2a1c9d0b71 cat=tool code=EPERM first=2026-09-14T09:12:33Z device=DESKTOP-A proj=报错的回收再利用 -->",
  "",
  "- 指纹: `3f2a1c9d0b71`",
  "- 分类: `tool / pwsh`",
  "- 首次: 2026-09-14 09:12 · 最近: 2026-09-14 15:40 · 命中: 5",
  "- 触发: `pnpm install` 在中文路径下写 `node_modules` 时被占用",
  "- 原始信息:",
  "  ```text",
  "  EPERM: operation not permitted, rename '<path>\\node_modules\\.pnpm\\<hash>'",
  "  ```",
  "- 解法:",
  "  关闭占用该目录的编辑器/杀软实时扫描后重跑 `pnpm install`；仍失败则改用 `pnpm install --config.node-linker=hoisted`。",
  "- 状态: `fixed`",
  "- 备注:",
  "",
].join("\n");

function doc(...entries: Entry[]): string {
  return DOCUMENT_HEADER + entries.map((e) => `\n${renderEntry(e)}`).join("");
}

/** A clock that only moves when something sleeps on it. */
class FakeClock implements StoreClock {
  t = Date.parse("2026-10-01T08:30:15.250Z");
  now = () => new Date(this.t);
  sleep = async (ms: number) => {
    this.t += ms;
  };
  random = () => 0.5;
}

/** An in-memory filesystem whose mtimes come from the fake clock. */
class MemoryFs implements StoreFs {
  files = new Map<string, { data: string; mtime: number }>();
  failRename = false;
  onLockRead?: () => void;
  constructor(private readonly clock: FakeClock) {}
  async readFile(path: string) {
    if (path.endsWith(".lock")) this.onLockRead?.();
    return this.files.get(path)?.data;
  }
  async writeFile(path: string, data: string) {
    this.files.set(path, { data, mtime: this.clock.t });
  }
  async appendFile(path: string, data: string) {
    await this.writeFile(path, (this.files.get(path)?.data ?? "") + data);
  }
  async rename(from: string, to: string) {
    const file = this.files.get(from);
    if (this.failRename || file === undefined) throw new Error("rename failed");
    this.files.delete(from);
    this.files.set(to, file);
  }
  async createExclusive(path: string, data: string) {
    if (this.files.has(path)) return false;
    await this.writeFile(path, data);
    return true;
  }
  async mtimeMs(path: string) {
    return this.files.get(path)?.mtime;
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async list(dir: string) {
    return [...this.files.keys()]
      .filter((path) => dirname(path) === dir)
      .map((path) => basename(path));
  }
  async mkdir() {}
}

const kbDir = resolve("/kb");
const files = filesIn(kbDir);

function memoryStore(options: Parameters<typeof createStore>[1] = {}) {
  const clock = new FakeClock();
  const fs = new MemoryFs(clock);
  const store = createStore(files, options, fs, clock);
  const text = (path: string) => fs.files.get(path)?.data;
  return { clock, fs, store, text };
}

const input = (n: number, extra: Partial<NewEntry> = {}): NewEntry => ({
  title: `[tool] failure number ${n}`,
  signature: `00000000000${n % 10}`,
  category: "tool / sh",
  meta: { cat: "tool", code: `E${n}` },
  raw: `failure number ${n}`,
  ...extra,
});

// ---------------------------------------------------------------------------
// IDs and machine fields

describe("IDs", () => {
  it("formats with prefix and width", () => {
    expect(formatId(7)).toBe("E-0007");
    expect(formatId(12345)).toBe("E-12345");
    expect(formatId(3, "ERR-", 2)).toBe("ERR-03");
  });

  it("scans headers leniently, ignoring anything that is not a header", () => {
    const text =
      "## E-0002 · a\n## E-0010 · b\n  ## E-0099 · indented\n## X-0050 · other\n";
    expect(scanIdNumbers(text)).toEqual([2, 10]);
    expect(scanIdNumbers("## X-0050 · other", "X-")).toEqual([50]);
  });

  it("takes the next number after the highest in any of the texts", () => {
    expect(nextIdNumber([])).toBe(1);
    expect(
      nextIdNumber(["## E-0003 · a", "## E-0009 · b\n## E-0004 · c"]),
    ).toBe(10);
  });
});

describe("machine-field values", () => {
  it("percent-encodes only what would break the comment, and decodes it back", () => {
    const value = "my proj 100%\t-->";
    const encoded = encodeMetaValue(value);
    expect(encoded).not.toMatch(/[\s>]/);
    expect(decodeMetaValue(encoded)).toBe(value);
    expect(encodeMetaValue("报错的回收再利用")).toBe("报错的回收再利用");
    expect(decodeMetaValue(encodeMetaValue("a　b"))).toBe("a　b");
  });

  it("keeps a malformed escape literally", () => {
    expect(decodeMetaValue("100%")).toBe("100%");
    expect(decodeMetaValue("bad%E3")).toBe("bad%E3");
  });
});

describe("timestamps", () => {
  it("formats the display and machine forms in UTC", () => {
    const date = new Date("2026-09-14T09:12:33.456Z");
    expect(formatSeen(date)).toBe("2026-09-14 09:12");
    expect(formatFirst(date)).toBe("2026-09-14T09:12:33Z");
  });
});

// ---------------------------------------------------------------------------
// Parse and render

describe("render → parse round-trip", () => {
  it("returns the same entry, for both label sets", () => {
    for (const labels of ["en", "zh"] as const) {
      const text = renderEntry(entry(), labels);
      const parsed = parseDocument(text);
      expect(parsed.blocks).toHaveLength(1);
      expect(parsed.blocks[0]?.entry).toEqual(entry());
    }
  });

  it("returns the same text for a whole document", () => {
    const text = doc(entry(), entry({ id: "E-0008", status: "open", fix: "" }));
    expect(renderDocument(parseDocument(text))).toBe(text);
  });

  it("round-trips empty fields, multi-line fields and odd characters", () => {
    const odd = entry({
      title: "",
      meta: { sig: "", proj: "a b>c%d" },
      fingerprint: "",
      category: "",
      firstSeen: "",
      lastSeen: "",
      hits: 0,
      trigger: "line one\nline two",
      raw: "\nfirst\n\n  indented\n```\nfence inside\n````",
      fix: "- step one\n- step two\n\n```sh\npnpm i\n```",
      status: "wontfix",
      notes:
        "## not a header, just text\n- Status: `open` (indented, so content)",
    });
    expect(parseDocument(renderEntry(odd)).blocks[0]?.entry).toEqual(odd);
    expect(parseDocument(renderEntry(odd, "zh")).blocks[0]?.entry).toEqual(odd);
  });

  it("writes the English labels by default and the Chinese ones on request", () => {
    expect(renderEntry(entry())).toContain("- Fix:\n");
    expect(renderEntry(entry())).toContain(
      "- First seen: 2026-09-14 09:12 · Last seen:",
    );
    expect(renderEntry(entry(), "zh")).toContain("- 解法:\n");
    for (const label of Object.values(LABELS.en))
      expect(renderEntry(entry())).toContain(label);
  });

  it("is byte-identical for arbitrary hand-edited text", () => {
    const text = [
      "# My errors",
      "",
      "Some notes before the first entry.",
      "",
      "## E-0001 · edited by hand  ",
      "<!-- antibody: sig=abc -->",
      "- Fix: on the same line",
      "",
      "",
      "## E-0002 · crlf\r",
      "<!-- antibody: sig=def -->\r",
      "- Status: open\r",
    ].join("\n");
    expect(renderDocument(parseDocument(text))).toBe(text);
  });
});

describe("parse: what a human may type", () => {
  it("reads the design document's §8 sample with Chinese labels", () => {
    const parsed = parseDocument(DESIGN_SAMPLE).blocks[0]?.entry;
    expect(parsed).toEqual(
      entry({
        meta: {
          ...entry().meta,
          device: "DESKTOP-A",
          proj: "报错的回收再利用",
        },
        trigger: "`pnpm install` 在中文路径下写 `node_modules` 时被占用",
        fix: "关闭占用该目录的编辑器/杀软实时扫描后重跑 `pnpm install`；仍失败则改用 `pnpm install --config.node-linker=hoisted`。",
      }),
    );
  });

  it("reads a hand-edited fix: same line, continuation lines, bullets, no indent", () => {
    const text = [
      "## E-0001 · x",
      "<!-- antibody: sig=a -->",
      "- Fix: restart the daemon",
      "and then:",
      "  - clear the cache",
      "  - run again",
      "- Status: `fixed`",
    ].join("\n");
    expect(parseDocument(text).blocks[0]?.entry.fix).toBe(
      [
        "restart the daemon",
        "and then:",
        "- clear the cache",
        "- run again",
      ].join("\n"),
    );
  });

  it("accepts both label sets in one document, and a full-width colon", () => {
    const text = [
      "## E-0001 · en",
      "<!-- antibody: sig=a -->",
      "- Fix: english",
      "## E-0002 · zh",
      "<!-- antibody: sig=b -->",
      "- 解法： 中文冒号",
      "- 状态： `wontfix`",
    ].join("\n");
    const [en, zh] = parseDocument(text).blocks.map((b) => b.entry);
    expect(en?.fix).toBe("english");
    expect(zh?.fix).toBe("中文冒号");
    expect(zh?.status).toBe("wontfix");
  });

  it("defaults missing fields and reads a status case-insensitively", () => {
    const parsed = parseDocument("## E-0001 ·\n<!-- antibody: -->\n").blocks[0]
      ?.entry;
    expect(parsed).toMatchObject({
      title: "",
      meta: {},
      fingerprint: "",
      raw: "",
      fix: "",
      status: "open",
      hits: 0,
    });
    expect(
      parseDocument("## E-0001 · a\n<!-- antibody: -->\n- Status: Fixed")
        .blocks[0]?.entry.status,
    ).toBe("fixed");
  });

  it("reads a raw message written inline, without a fence", () => {
    const text = "## E-0001 · a\n<!-- antibody: -->\n- Raw message: plain text";
    expect(parseDocument(text).blocks[0]?.entry.raw).toBe("plain text");
  });

  it("treats an empty text as an empty document, and keeps the preamble", () => {
    expect(parseDocument("")).toEqual({ preamble: "", blocks: [] });
    expect(parseDocument("# Title\n\nprose\n").preamble).toBe(
      "# Title\n\nprose\n",
    );
  });

  it("honours a different ID prefix", () => {
    const text = renderEntry(entry({ id: "ERR-12" }));
    expect(parseDocument(text, "ERR-").blocks[0]?.entry.id).toBe("ERR-12");
    expect(parseDocument(text).blocks).toHaveLength(0);
  });

  it("detects which label set a block was written in", () => {
    expect(detectLabels(renderEntry(entry(), "zh"))).toBe("zh");
    expect(detectLabels(renderEntry(entry(), "en"))).toBe("en");
    expect(detectLabels("## E-0001 · a\n- Other: x\n")).toBeUndefined();
  });
});

describe("parse: what makes a document unsafe to rewrite", () => {
  const cases: Array<[string, string, number]> = [
    [
      "git conflict marker",
      "## E-0001 · a\n<!-- antibody: -->\n<<<<<<< HEAD\n",
      3,
    ],
    ["git conflict separator", "=======\n", 1],
    ["malformed entry header", "## E-0001 missing dot\n", 1],
    ["no machine comment", "# t\n## E-0001 · a\n- Fix: x\n", 2],
    [
      "second machine comment",
      "## E-0001 · a\n<!-- antibody: -->\n<!-- antibody: -->\n",
      3,
    ],
    ["malformed machine field", "## E-0001 · a\n<!-- antibody: sig -->\n", 2],
    [
      "duplicate ID",
      "## E-0001 · a\n<!-- antibody: -->\n## E-0001 · b\n<!-- antibody: -->\n",
      3,
    ],
    [
      "duplicate field",
      "## E-0001 · a\n<!-- antibody: -->\n- Fix: a\n- 解法: b\n",
      4,
    ],
    [
      "unknown status",
      "## E-0001 · a\n<!-- antibody: -->\n- Status: `done`\n",
      3,
    ],
    [
      "malformed seen line",
      "## E-0001 · a\n<!-- antibody: -->\n- First seen: today\n",
      3,
    ],
    [
      "non-numeric hits",
      "## E-0001 · a\n<!-- antibody: -->\n- First seen: a · Last seen: b · Hits: many\n",
      3,
    ],
    [
      "unterminated fence",
      "## E-0001 · a\n<!-- antibody: -->\n- Raw message:\n  ```text\n  x\n",
      3,
    ],
  ];

  for (const [name, text, line] of cases)
    it(`rejects: ${name} (line ${line})`, () => {
      let caught: unknown;
      try {
        parseDocument(text);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ParseError);
      expect((caught as ParseError).line).toBe(line);
      expect((caught as ParseError).message).toContain(`line ${line}`);
    });
});

// ---------------------------------------------------------------------------
// The store, on an in-memory filesystem

describe("store: append", () => {
  it("creates the document and numbers entries from E-0001", async () => {
    const { store, text } = memoryStore();
    expect(await store.append(input(1))).toEqual({
      id: "E-0001",
      archived: [],
      corrupt: false,
    });
    expect((await store.append(input(2))).id).toBe("E-0002");
    const written = text(files.errors) as string;
    expect(written.startsWith(`${DOCUMENT_HEADER}\n## E-0001 · `)).toBe(true);
    expect(written).toContain("\n\n## E-0002 · ");
    expect(parseDocument(written).blocks.map((b) => b.entry.id)).toEqual([
      "E-0001",
      "E-0002",
    ]);
  });

  it("fills the entry from the input and the clock", async () => {
    const { store } = memoryStore();
    await store.append(
      input(1, { trigger: "make", fix: "  fix  ", notes: "n" }),
    );
    expect((await store.read()).blocks[0]?.entry).toEqual({
      id: "E-0001",
      title: "[tool] failure number 1",
      meta: {
        sig: "000000000001",
        cat: "tool",
        code: "E1",
        first: "2026-10-01T08:30:15Z",
      },
      fingerprint: "000000000001",
      category: "tool / sh",
      firstSeen: "2026-10-01 08:30",
      lastSeen: "2026-10-01 08:30",
      hits: 1,
      trigger: "make",
      raw: "failure number 1",
      fix: "fix",
      status: "open",
      notes: "n",
    });
  });

  it("keeps a caller's first= and status, and defaults the optional texts", async () => {
    const { store } = memoryStore();
    await store.append({
      title: "t",
      signature: "abc",
      category: "c",
      meta: { first: "2020-01-01T00:00:00Z" },
      status: "wontfix",
    });
    const stored = (await store.read()).blocks[0]?.entry;
    expect(stored?.meta.first).toBe("2020-01-01T00:00:00Z");
    expect(stored).toMatchObject({
      status: "wontfix",
      trigger: "",
      raw: "",
      fix: "",
    });
  });

  it("redacts every text before it is written, and caps the sample", async () => {
    const { store, text } = memoryStore({ maxSampleChars: 40 });
    const secret = ["sk-", "Zq7Xw2Lp9Rt4Vb8Nm3Kd6Hs1"].join("");
    await store.append(
      input(1, {
        title: `key ${secret}\nsecond line`,
        raw: `401 with ${secret} at ${["", "home", "kim", "p", "a.ts"].join("/")} ${"y".repeat(100)}`,
        fix: `rotate ${secret}`,
        meta: { cat: "tool", proj: ["", "Users", "kim", "proj"].join("/") },
      }),
    );
    const written = text(files.errors) as string;
    expect(written).not.toContain(secret);
    expect(written).not.toContain("kim");
    const stored = (await store.read()).blocks[0]?.entry as Entry;
    expect(stored.title).toBe("key <secret> second line");
    expect(stored.raw).toBe(
      `401 with <secret> at <path>/a.ts ${"y".repeat(7)}…`,
    );
  });

  it("writes Chinese labels when configured", async () => {
    const { store, text } = memoryStore({ labels: "zh" });
    await store.append(input(1));
    expect(text(files.errors)).toContain("- 解法:");
  });

  it("assigns strictly increasing IDs, never reusing an archived one", async () => {
    const { store, fs } = memoryStore();
    await fs.writeFile(files.archive, `${ARCHIVE_HEADER}\n## E-0041 · old\n`);
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push((await store.append(input(n))).id);
    expect(ids).toEqual(["E-0042", "E-0043", "E-0044", "E-0045", "E-0046"]);
  });

  it("appends after a document that lacks a trailing newline", async () => {
    const { store, fs, text } = memoryStore();
    await fs.writeFile(files.errors, "# Mine");
    await store.append(input(1));
    expect(
      (text(files.errors) as string).startsWith("# Mine\n\n## E-0001 · "),
    ).toBe(true);
  });
});

describe("store: archive", () => {
  it("moves the oldest entries past maxEntries, append-only", async () => {
    const { store, text } = memoryStore({ maxEntries: 3 });
    for (let n = 1; n <= 4; n++) await store.append(input(n));
    const firstArchive = text(files.archive) as string;
    expect(firstArchive.startsWith(`${ARCHIVE_HEADER}\n## E-0001 · `)).toBe(
      true,
    );

    const result = await store.append(input(5));
    expect(result).toEqual({
      id: "E-0005",
      archived: ["E-0002"],
      corrupt: false,
    });

    const archive = text(files.archive) as string;
    expect(archive.startsWith(firstArchive)).toBe(true);
    expect(parseDocument(archive).blocks.map((b) => b.entry.id)).toEqual([
      "E-0001",
      "E-0002",
    ]);
    expect(archive).toContain("\n\n## E-0002 · ");
    expect((await store.read()).blocks.map((b) => b.entry.id)).toEqual([
      "E-0003",
      "E-0004",
      "E-0005",
    ]);
    expect((await store.read()).preamble).toBe(`${DOCUMENT_HEADER}\n`);
    expect((await store.append(input(6))).id).toBe("E-0006");
  });

  it("moves several entries at once when the limit drops", async () => {
    const big = memoryStore({ maxEntries: 10 });
    for (let n = 1; n <= 4; n++) await big.store.append(input(n));
    const small = createStore(files, { maxEntries: 1 }, big.fs, big.clock);
    expect((await small.append(input(5))).archived).toEqual([
      "E-0001",
      "E-0002",
      "E-0003",
      "E-0004",
    ]);
  });
});

describe("store: archive one entry (antibody_forget, T15)", () => {
  it("moves the entry to the archive with the reason in its notes", async () => {
    const { store, text } = memoryStore();
    for (let n = 1; n <= 3; n++) await store.append(input(n));
    const before = parseDocument(text(files.errors) as string);
    const archived = await store.archive("E-0002", "  misjudged:\n a typo  ");
    expect(archived).toMatchObject({
      id: "E-0002",
      notes: "Archived 2026-10-01 08:30: misjudged: a typo",
    });
    const after = parseDocument(text(files.errors) as string);
    expect(after.blocks.map((b) => b.entry.id)).toEqual(["E-0001", "E-0003"]);
    expect(after.blocks[0]?.source).toBe(before.blocks[0]?.source);
    const archive = text(files.archive) as string;
    expect(archive.startsWith(`${ARCHIVE_HEADER}\n## E-0002 · `)).toBe(true);
    expect(parseDocument(archive).blocks[0]?.entry).toEqual(archived);
    // An archived ID is never reused.
    expect((await store.append(input(4))).id).toBe("E-0004");
  });

  it("appends to an existing archive and keeps earlier notes", async () => {
    const { store, text } = memoryStore();
    await store.append(input(1, { notes: "first note" }));
    await store.append(input(2));
    await store.archive("E-0002");
    const first = text(files.archive) as string;
    const archived = await store.archive("E-0001");
    expect(archived?.notes).toBe("first note\nArchived 2026-10-01 08:30");
    const archive = text(files.archive) as string;
    expect(archive.startsWith(first)).toBe(true);
    expect(parseDocument(archive).blocks.map((b) => b.entry.id)).toEqual([
      "E-0002",
      "E-0001",
    ]);
    expect((await store.read()).blocks).toEqual([]);
  });

  it("returns undefined for an unknown ID and writes nothing", async () => {
    const { store, text } = memoryStore();
    await store.append(input(1));
    const before = text(files.errors);
    expect(await store.archive("E-0099", "x")).toBeUndefined();
    expect(text(files.errors)).toBe(before);
    expect(text(files.archive)).toBeUndefined();
  });

  it("refuses a document that does not parse", async () => {
    const { store, fs } = memoryStore();
    await fs.writeFile(files.errors, "## E-0001 · broken\n");
    await expect(store.archive("E-0001")).rejects.toBeInstanceOf(
      StoreCorruptError,
    );
  });
});

describe("store: update", () => {
  it("changes fix, status, notes, trigger, lastSeen and hits of one entry only", async () => {
    const { store, text } = memoryStore();
    for (let n = 1; n <= 3; n++) await store.append(input(n));
    const before = parseDocument(text(files.errors) as string);
    const updated = await store.update("E-0002", {
      fix: "do the thing",
      status: "fixed",
      notes: "seen on CI",
      trigger: "pnpm test",
      lastSeen: "2026-10-02 10:00",
      hits: 3,
    });
    expect(updated).toMatchObject({
      id: "E-0002",
      fix: "do the thing",
      status: "fixed",
      notes: "seen on CI",
      trigger: "pnpm test",
      lastSeen: "2026-10-02 10:00",
      hits: 3,
    });
    const after = parseDocument(text(files.errors) as string);
    expect(after.blocks[0]?.source).toBe(before.blocks[0]?.source);
    expect(after.blocks[2]?.source).toBe(before.blocks[2]?.source);
    expect(after.blocks[1]?.entry).toEqual(updated);
    expect(after.blocks[1]?.source.endsWith("\n\n")).toBe(true);
  });

  it("leaves a patch's missing fields alone and redacts the new text", async () => {
    const { store } = memoryStore();
    await store.append(input(1, { fix: "keep me", notes: "and me" }));
    const secret = ["ghp_", "Zq7Xw2Lp9Rt4Vb8Nm3Kd6Hs1"].join("");
    const updated = await store.update("E-0001", { status: "wontfix" });
    expect(updated).toMatchObject({ fix: "keep me", notes: "and me" });
    expect((await store.update("E-0001", { fix: `use ${secret}` }))?.fix).toBe(
      "use <secret>",
    );
  });

  it("sets and removes machine fields, and refuses a name that would split the comment", async () => {
    const { store, text } = memoryStore();
    await store.append(input(1));
    const set = await store.update("E-0001", {
      meta: { review: "pending", note: "two words" },
    });
    expect(set?.meta).toMatchObject({ review: "pending", note: "two words" });
    expect(
      parseDocument(text(files.errors) as string).blocks[0]?.entry.meta,
    ).toEqual(set?.meta);
    const removed = await store.update("E-0001", {
      meta: { review: null, absent: null },
    });
    expect(Object.keys(removed?.meta ?? {})).toEqual([
      "sig",
      "cat",
      "code",
      "first",
      "note",
    ]);
    await expect(
      store.update("E-0001", { meta: { "two words": "x" } }),
    ).rejects.toThrow(RangeError);
  });

  it("returns undefined for an unknown ID and writes nothing", async () => {
    const { store, text } = memoryStore();
    await store.append(input(1));
    const before = text(files.errors);
    expect(await store.update("E-0099", { fix: "x" })).toBeUndefined();
    expect(text(files.errors)).toBe(before);
  });

  it("keeps a hand edit, and the label language of the block it rewrites", async () => {
    const { store, fs, text } = memoryStore({ labels: "en" });
    await fs.writeFile(
      files.errors,
      `${DOCUMENT_HEADER}\n${DESIGN_SAMPLE}\n## E-0008 · hand written\n<!-- antibody: sig=b -->\n- Fix: typed by hand\n`,
    );
    expect((await store.read()).blocks[1]?.entry.fix).toBe("typed by hand");
    await store.update("E-0007", { status: "open" });
    const written = text(files.errors) as string;
    expect(written).toContain("- 状态: `open`");
    expect(written).not.toContain("- Status:");
    expect(
      written.endsWith(
        "## E-0008 · hand written\n<!-- antibody: sig=b -->\n- Fix: typed by hand\n",
      ),
    ).toBe(true);
  });

  it("writes a block that had no trailing newline with one", async () => {
    const { store, fs, text } = memoryStore();
    await fs.writeFile(files.errors, "## E-0001 · a\n<!-- antibody: -->");
    await store.update("E-0001", { fix: "x" });
    expect((text(files.errors) as string).endsWith("- Notes:\n")).toBe(true);
  });
});

describe("store: a corrupt document", () => {
  const broken = `${DOCUMENT_HEADER}\n## E-0003 · a\n<!-- antibody: -->\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n`;

  it("is saved aside once and then only appended to, never rewritten", async () => {
    const { store, fs, text } = memoryStore();
    await fs.writeFile(files.errors, broken);

    const first = await store.append(input(1));
    expect(first).toMatchObject({ id: "E-0004", corrupt: true, archived: [] });
    expect(first.savedAs).toBe(
      "ANTIBODIES.corrupt-2026-10-01T08-30-15-250Z.md",
    );
    expect(text(join(kbDir, first.savedAs as string))).toBe(broken);

    const afterFirst = text(files.errors) as string;
    expect(afterFirst.startsWith(broken)).toBe(true);
    expect(afterFirst.slice(broken.length)).toMatch(/^\n## E-0004 · /);

    const second = await store.append(input(2));
    expect(second).toMatchObject({ id: "E-0005", corrupt: true });
    expect(second.savedAs).toBeUndefined();
    expect((text(files.errors) as string).startsWith(afterFirst)).toBe(true);
  });

  it("refuses an update, saving the original aside", async () => {
    const { store, fs, text } = memoryStore();
    await fs.writeFile(files.errors, broken);
    await fs.writeFile(
      join(kbDir, "ANTIBODIES.corrupt-unrelated.md"),
      "something else",
    );
    await fs.writeFile(join(kbDir, "ANTIBODIES.corrupt-empty.md"), "");
    await fs.writeFile(join(kbDir, "notes.md"), broken);
    const error = await store.update("E-0003", { fix: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(StoreCorruptError);
    expect((error as StoreCorruptError).parseError).toBeInstanceOf(ParseError);
    expect((error as StoreCorruptError).savedAs).toMatch(
      /^ANTIBODIES\.corrupt-2026/,
    );
    expect(text(files.errors)).toBe(broken);
  });

  it("propagates a non-parse failure instead of treating it as corruption", async () => {
    const { store, fs } = memoryStore();
    await store.append(input(1));
    fs.readFile = async () => {
      throw new Error("disk gone");
    };
    await expect(store.append(input(2))).rejects.toThrow("disk gone");
  });
});

describe("store: lock and atomic write", () => {
  it("waits for a held lock and proceeds once it is released", async () => {
    const { store, fs, clock } = memoryStore();
    await fs.writeFile(files.lock, "someone");
    clock.sleep = async (ms) => {
      clock.t += ms;
      await fs.remove(files.lock);
    };
    expect((await store.append(input(1))).id).toBe("E-0001");
    expect(fs.files.has(files.lock)).toBe(false);
  });

  it("takes over a lock older than the stale limit", async () => {
    const { store, fs, clock } = memoryStore();
    await fs.writeFile(files.lock, "crashed writer");
    clock.t += 10_001;
    expect((await store.append(input(1))).id).toBe("E-0001");
    expect(fs.files.has(files.lock)).toBe(false);
  });

  it("two waiters on one stale lock: the second does not remove the first one's fresh lock", async () => {
    const clock = new FakeClock();
    const shared = new MemoryFs(clock);
    await shared.writeFile(files.lock, "crashed writer");
    clock.t += 10_001;

    // A takes over the stale lock, then pauses while holding it until B has
    // finished deciding what to do about the lock it judged stale earlier.
    let aToken: string | undefined;
    let aHolds!: () => void;
    const aHolding = new Promise<void>((done) => (aHolds = done));
    let bDecided!: () => void;
    const bDone = new Promise<void>((done) => (bDecided = done));
    const fsA: StoreFs = Object.create(shared);
    fsA.createExclusive = async (path, data) => {
      const created = await shared.createExclusive(path, data);
      if (created && path === files.lock) {
        aToken = data;
        aHolds();
      }
      return created;
    };
    fsA.readFile = async (path) => {
      if (path === files.errors) await bDone;
      return shared.readFile(path);
    };

    // B judges the same lock stale, then stalls until A holds a fresh one.
    let lockOnDiskWhenBDecided: string | undefined;
    let stalled = false;
    const fsB: StoreFs = Object.create(shared);
    fsB.mtimeMs = async (path) => {
      const mtime = await shared.mtimeMs(path);
      if (!stalled) {
        stalled = true;
        await aHolding;
      }
      return mtime;
    };
    const decide = () => {
      lockOnDiskWhenBDecided ??= shared.files.get(files.lock)?.data;
      bDecided();
    };
    fsB.createExclusive = async (path, data) => {
      const created = await shared.createExclusive(path, data);
      if (created && aToken !== undefined) decide();
      return created;
    };
    const clockB: StoreClock = {
      now: clock.now,
      random: clock.random,
      sleep: async (ms) => {
        decide();
        await clock.sleep(ms);
      },
    };

    const a = createStore(files, {}, fsA, clock);
    const b = createStore(files, {}, fsB, clockB);
    const [resultA, resultB] = await Promise.all([
      a.append(input(1)),
      b.append(input(2)),
    ]);

    expect(aToken).toBeDefined();
    expect(lockOnDiskWhenBDecided).toBe(aToken);
    expect(new Set([resultA.id, resultB.id])).toEqual(
      new Set(["E-0001", "E-0002"]),
    );
    const document = parseDocument(shared.files.get(files.errors)?.data ?? "");
    expect(document.blocks.map((block) => block.entry.id)).toEqual([
      "E-0001",
      "E-0002",
    ]);
    expect(shared.files.has(files.lock)).toBe(false);
  });

  it("gives up after the timeout while a live lock is held", async () => {
    const { store, fs, clock } = memoryStore({
      lockTimeoutMs: 200,
      lockStaleMs: 60_000,
    });
    await fs.writeFile(files.lock, "busy");
    clock.sleep = async (ms) => {
      clock.t += ms;
      await fs.writeFile(files.lock, "still busy"); // a live lock keeps its mtime fresh
    };
    const error = await store.append(input(1)).catch((e) => e);
    expect(error).toBeInstanceOf(LockTimeoutError);
    expect((error as LockTimeoutError).path).toBe(files.lock);
    expect(fs.files.get(files.lock)?.data).toBe("still busy");
    expect(fs.files.has(files.errors)).toBe(false);
  });

  it("does not release a lock that someone else took over", async () => {
    const { store, fs } = memoryStore();
    fs.onLockRead = () => {
      fs.files.set(files.lock, { data: "the new owner", mtime: 0 });
    };
    await store.append(input(1));
    expect(fs.files.get(files.lock)?.data).toBe("the new owner");
  });

  it("releases the lock and removes the temp file when the rename fails", async () => {
    const { store, fs } = memoryStore();
    fs.failRename = true;
    await expect(store.append(input(1))).rejects.toThrow("rename failed");
    expect([...fs.files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
    expect(fs.files.has(files.lock)).toBe(false);
    expect(fs.files.has(files.errors)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The store on a real disk

describe("store: real filesystem", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "errkb-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends, updates and reads back, leaving no lock or temp file", async () => {
    const kb = join(dir, "nested", "errors");
    const store = createStore(filesIn(kb));
    expect(await store.read()).toEqual({ preamble: "", blocks: [] });
    expect((await store.append(input(1))).id).toBe("E-0001");
    await store.update("E-0001", { fix: "fixed by test", status: "fixed" });
    const read = await store.read();
    expect(read.blocks[0]?.entry).toMatchObject({
      fix: "fixed by test",
      status: "fixed",
    });
    expect(readdirSync(kb).sort()).toEqual(["ANTIBODIES.md"]);
  });

  it("50 concurrent records yield 50 unique IDs and a document that parses completely", async () => {
    const kb = filesIn(dir);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        createStore(kb, { lockRetryMs: 2 }).append(input(n)),
      ),
    );
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(50);
    const parsed = parseDocument(readFileSync(kb.errors, "utf8"));
    expect(parsed.blocks).toHaveLength(50);
    expect(parsed.blocks.map((b) => b.entry.id).sort()).toEqual(
      Array.from({ length: 50 }, (_, n) => formatId(n + 1)),
    );
    expect(readdirSync(dir)).toEqual(["ANTIBODIES.md"]);
  });

  it("reports missing things as values and real failures as errors", async () => {
    const fs = nodeStoreFs();
    const file = join(dir, "file.txt");
    writeFileSync(file, "x");
    expect(await fs.readFile(join(dir, "missing"))).toBeUndefined();
    expect(await fs.mtimeMs(join(dir, "missing"))).toBeUndefined();
    expect(await fs.list(join(dir, "missing"))).toEqual([]);
    expect(await fs.createExclusive(file, "y")).toBe(false);
    await expect(fs.readFile(dir)).rejects.toThrow();
    await expect(
      fs.createExclusive(join(dir, "no", "such", "dir"), "y"),
    ).rejects.toThrow();
    await expect(fs.mtimeMs(join(file, "child"))).rejects.toThrow();
    await expect(fs.list(file)).rejects.toThrow();
    await fs.remove(join(dir, "missing"));
    await fs.appendFile(file, "z");
    expect(await fs.readFile(file)).toBe("xz");
  });

  it("uses the real clock", async () => {
    const clock = systemClock();
    expect(clock.now()).toBeInstanceOf(Date);
    const r = clock.random();
    expect(r >= 0 && r < 1).toBe(true);
    await expect(clock.sleep(1)).resolves.toBeUndefined();
  });
});
