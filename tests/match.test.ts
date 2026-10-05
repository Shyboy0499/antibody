// Ported from dsh-errkb, tests/match.test.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_OPTIONS,
  SHORT_MESSAGE_CHARS,
  indexEntries,
  jaccard,
  match,
  tokenize,
} from "../src/match";
import type { CapturedError, Hit } from "../src/match";
import { normalize, signature } from "../src/signature";
import { parseDocument } from "../src/store";
import type { Entry } from "../src/store";

// ---------------------------------------------------------------------------
// Fixtures

/**
 * An entry recorded from `message` under `category`; tests override what they
 * care about. The signature is the real one, so an identical message is an
 * exact hit.
 */
function entry(
  id: string,
  message: string,
  overrides: Partial<Entry> & { cat?: string; code?: string } = {},
): Entry {
  const { cat = "tool", code, meta, ...rest } = overrides;
  const sig = signature(cat, message);
  return {
    id,
    title: `[${cat}] ${message.slice(0, 40)}`,
    meta: {
      sig,
      cat,
      ...(code === undefined ? {} : { code }),
      first: "2026-10-01T00:00:00Z",
      ...meta,
    },
    fingerprint: sig,
    category: `${cat} / sh`,
    firstSeen: "2026-10-01 00:00",
    lastSeen: "2026-10-01 00:00",
    hits: 1,
    trigger: "",
    raw: message,
    fix: "",
    status: "open",
    notes: "",
    ...rest,
  };
}

const error = (
  message: string,
  extra: Partial<CapturedError> = {},
): CapturedError => ({ category: "tool", message, ...extra });

const run = (e: CapturedError, entries: Entry[], threshold?: number) =>
  match(
    e,
    indexEntries(entries),
    threshold === undefined ? {} : { fuzzyThreshold: threshold },
  );

/** Assert a hit and return it typed. */
function expectHit(result: ReturnType<typeof match>): Hit {
  expect(result.matched).toBe(true);
  return result as Hit;
}

/** `count` distinct word tokens, `w0 w1 ...`. */
const words = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => `w${from + i}`).join(" ");

// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("splits Latin and number runs into words on normalize() output", () => {
    expect([...tokenize(normalize("Cannot find module 'Foo_bar' v2"))]).toEqual(
      ["cannot", "find", "module", "foo_bar", "v2"],
    );
  });

  it("keeps a placeholder as one token", () => {
    const text = normalize(
      "ENOENT: open '/srv/app/package.json' at 2026-10-01T08:00:00Z",
    );
    expect(text).toContain("<path>/package.json");
    expect([...tokenize(text)]).toEqual([
      "enoent",
      "open",
      "<path>",
      "package",
      "json",
      "at",
      "<ts>",
    ]);
  });

  it("turns a CJK run into character bigrams, and one character into a unigram", () => {
    expect([...tokenize("拒绝访问")]).toEqual(["拒绝", "绝访", "访问"]);
    expect([...tokenize("错")]).toEqual(["错"]);
    expect([...tokenize("ファイル 파일")]).toEqual([
      "ファ",
      "ァイ",
      "イル",
      "파일",
    ]);
  });

  it("splits mixed CJK and Latin text at the script boundary", () => {
    expect([
      ...tokenize(
        normalize("EPERM: 拒绝访问, rename 'D:/a/b.txt' 错 eperm拒绝"),
      ),
    ]).toEqual([
      "eperm",
      "拒绝",
      "绝访",
      "访问",
      "rename",
      "<path>",
      "b",
      "txt",
      "错",
    ]);
  });

  it("returns an empty set for empty or punctuation-only text", () => {
    expect(tokenize("").size).toBe(0);
    expect(tokenize(" ,.:;!? ").size).toBe(0);
  });
});

describe("jaccard", () => {
  it("is shared over all tokens, symmetric", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d", "e"]);
    expect(jaccard(a, b)).toBe(2 / 5);
    expect(jaccard(b, a)).toBe(2 / 5);
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, new Set(["x"]))).toBe(0);
  });

  it("is 0 for two empty sets, and for one empty set", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
  });
});

describe("match: exact", () => {
  it("hits an entry with the same signature, not approximate", () => {
    const target = entry("E-0002", "EPERM: operation not permitted, rename");
    const result = expectHit(
      run(error("EPERM: operation not permitted, rename"), [
        entry("E-0001", "something else entirely"),
        target,
      ]),
    );
    expect(result).toEqual({
      matched: true,
      id: "E-0002",
      entry: target,
      via: "exact",
      approximate: false,
      similarity: 1,
      injectable: true,
    });
  });

  it("hits through run-to-run noise, because the signature is normalized", () => {
    const result = run(
      error("EPERM: rename '/srv/one/node_modules' pid 4242"),
      [entry("E-0001", "EPERM: rename '/opt/two/node_modules' pid 17")],
    );
    expect(expectHit(result).via).toBe("exact");
  });

  it("matches every seed entry by its own raw message", () => {
    const seedFile = resolve(
      fileURLToPath(new URL("..", import.meta.url)),
      "seeds",
      "ERRORS.seed.md",
    );
    const entries = parseDocument(readFileSync(seedFile, "utf8")).blocks.map(
      (b) => b.entry,
    );
    for (const seed of entries) {
      const result = run(
        error(seed.raw, { category: seed.meta.cat as string }),
        entries,
      );
      expect(expectHit(result)).toMatchObject({ id: seed.id, via: "exact" });
    }
  });

  it("falls back to the fingerprint when an entry has no sig= field", () => {
    const e = entry("E-0001", "boom");
    delete e.meta.sig;
    expect(expectHit(run(error("boom"), [e])).via).toBe("exact");
  });
});

describe("match: fuzzy, at the threshold", () => {
  // The entry has 100 distinct tokens; the error repeats the first k of them,
  // so the similarity is exactly k / 100.
  const base = entry("E-0001", words(100));
  const at = (k: number) => run(error(words(k)), [base]);

  it("uses 0.72 by default", () => {
    expect(DEFAULT_MATCH_OPTIONS.fuzzyThreshold).toBe(0.72);
  });

  it("misses at 0.71", () => {
    expect(at(71)).toEqual({ matched: false });
  });

  it("is a near hit at exactly 0.72", () => {
    expect(expectHit(at(72))).toMatchObject({
      id: "E-0001",
      via: "fuzzy",
      approximate: true,
      similarity: 0.72,
      injectable: true,
    });
  });

  it("is a near hit at 0.73", () => {
    expect(expectHit(at(73))).toMatchObject({
      via: "fuzzy",
      similarity: 0.73,
    });
  });

  it("honours a configured threshold", () => {
    expect(run(error(words(72)), [base], 0.73)).toEqual({ matched: false });
    expect(run(error(words(50)), [base], 0.5).matched).toBe(true);
  });

  it("only considers entries of the same category", () => {
    const other = entry("E-0001", words(100), { cat: "llm" });
    expect(run(error(words(90)), [other])).toEqual({ matched: false });
  });

  it("reads the category from the display field when cat= is missing", () => {
    const e = entry("E-0001", words(100));
    delete e.meta.cat;
    expect(run(error(words(90)), [e]).matched).toBe(true);
    expect(run(error(words(90), { category: "sh" }), [e]).matched).toBe(false);
  });

  it("compares by the title when an entry has no raw sample", () => {
    const e = entry("E-0001", "unused", { raw: "", title: words(100) });
    expect(expectHit(run(error(words(90)), [e])).similarity).toBe(0.9);
  });
});

describe("match: CJK", () => {
  const recorded =
    "无法写入配置文件，因为另一个程序正在使用此文件，请关闭占用该文件的编辑器后重试";

  it("lands two messages that differ by one word above the threshold", () => {
    const result = run(
      error(
        "无法读取配置文件，因为另一个程序正在使用此文件，请关闭占用该文件的编辑器后重试",
      ),
      [entry("E-0001", recorded)],
    );
    const hit = expectHit(result);
    expect(hit.via).toBe("fuzzy");
    expect(hit.similarity).toBeGreaterThan(0.72);
  });

  it("lands an unrelated message far below it", () => {
    const tokens = tokenize(normalize("网络连接超时，请稍后检查代理设置"));
    expect(jaccard(tokens, tokenize(normalize(recorded)))).toBeLessThan(0.2);
    expect(
      run(error("网络连接超时，请稍后检查代理设置"), [
        entry("E-0001", recorded),
      ]),
    ).toEqual({ matched: false });
  });

  it("matches a mixed CJK and Latin message across a changed path", () => {
    const result = run(
      error(
        "EPERM: 拒绝访问。rename 'D:/work/new/node_modules/.pnpm/lock.yaml'",
      ),
      [entry("E-0001", "EPERM: 拒绝访问。rename 'C:/old/node_modules/x.yaml'")],
    );
    expect(expectHit(result)).toMatchObject({
      via: "fuzzy",
      approximate: true,
    });
  });
});

describe("match: same-code fallback", () => {
  const recorded = entry("E-0001", "no adapter for provider", {
    cat: "llm",
    code: "NO_ADAPTER",
  });

  it("is a near hit for two short messages with the same category and code", () => {
    const result = run(
      error("adapter missing", { category: "llm", code: "NO_ADAPTER" }),
      [recorded],
    );
    expect(expectHit(result)).toMatchObject({
      id: "E-0001",
      via: "code",
      approximate: true,
      similarity: 1 / 5,
      injectable: true,
    });
  });

  it(`does not fire when the error's message is ${SHORT_MESSAGE_CHARS} characters or more`, () => {
    const long = "x".repeat(SHORT_MESSAGE_CHARS);
    const justShort = "x".repeat(SHORT_MESSAGE_CHARS - 1);
    const as = (message: string) =>
      run(error(message, { category: "llm", code: "NO_ADAPTER" }), [recorded]);
    expect(as(long)).toEqual({ matched: false });
    expect(expectHit(as(justShort)).via).toBe("code");
  });

  it("does not fire when the entry's message is 40 characters or more", () => {
    const longEntry = entry("E-0001", "y".repeat(SHORT_MESSAGE_CHARS), {
      cat: "llm",
      code: "NO_ADAPTER",
    });
    expect(
      run(error("adapter missing", { category: "llm", code: "NO_ADAPTER" }), [
        longEntry,
      ]),
    ).toEqual({ matched: false });
  });

  it("does not fire across categories, across codes, or without a code", () => {
    const tool = entry("E-0001", "no adapter", { cat: "tool", code: "X" });
    expect(
      run(error("missing", { category: "llm", code: "X" }), [tool]),
    ).toEqual({ matched: false });
    expect(
      run(error("missing", { category: "llm", code: "OTHER" }), [recorded]),
    ).toEqual({ matched: false });
    expect(run(error("missing", { category: "llm" }), [recorded])).toEqual({
      matched: false,
    });
    expect(
      run(error("missing", { category: "llm", code: "" }), [
        entry("E-0002", "x", { cat: "llm", code: "" }),
      ]),
    ).toEqual({ matched: false });
  });

  it("is only a fallback: a fuzzy hit on another entry wins", () => {
    const fuzzyTarget = entry("E-0002", "adapter missing now", { cat: "llm" });
    const result = run(
      error("adapter missing", { category: "llm", code: "NO_ADAPTER" }),
      [recorded, fuzzyTarget],
      0.6,
    );
    expect(expectHit(result)).toMatchObject({ id: "E-0002", via: "fuzzy" });
  });
});

describe("match: entries that must not be injected", () => {
  it("still matches a wontfix entry, but marks it not injectable", () => {
    const e = entry("E-0001", "flaky network", { status: "wontfix" });
    expect(expectHit(run(error("flaky network"), [e]))).toMatchObject({
      id: "E-0001",
      via: "exact",
      injectable: false,
      excluded: "wontfix",
    });
  });

  it("still matches a misjudged entry, exact or near, but marks it not injectable", () => {
    const e = entry("E-0001", words(100), { meta: { misjudged: "true" } });
    expect(expectHit(run(error(words(100)), [e]))).toMatchObject({
      via: "exact",
      injectable: false,
      excluded: "misjudged",
    });
    expect(expectHit(run(error(words(90)), [e]))).toMatchObject({
      via: "fuzzy",
      injectable: false,
      excluded: "misjudged",
    });
  });

  it("reads the misjudged flag case-insensitively and ignores other values", () => {
    const flagged = (value: string) =>
      run(error("boom"), [
        entry("E-0001", "boom", { meta: { misjudged: value } }),
      ]);
    expect(expectHit(flagged("TRUE")).injectable).toBe(false);
    expect(expectHit(flagged("false")).injectable).toBe(true);
  });

  it("reads the flag from a parsed document's machine comment", () => {
    const text = [
      "# ERRORS",
      "",
      "## E-0001 · [tool] boom",
      `<!-- errkb: sig=${signature("tool", "boom")} cat=tool misjudged=true -->`,
      "",
      "- Raw message: boom",
      "",
    ].join("\n");
    const entries = parseDocument(text).blocks.map((b) => b.entry);
    expect(expectHit(run(error("boom"), entries)).excluded).toBe("misjudged");
  });

  it("reports wontfix over misjudged when an entry is both", () => {
    const e = entry("E-0001", "boom", {
      status: "wontfix",
      meta: { misjudged: "true" },
    });
    expect(expectHit(run(error("boom"), [e])).excluded).toBe("wontfix");
  });
});

describe("match: ties", () => {
  it("prefers the highest similarity over the project and the ID", () => {
    const result = run(error(words(10), { proj: "mine" }), [
      entry("E-0001", words(12), { meta: { proj: "mine" } }),
      entry("E-0002", words(11)),
    ]);
    expect(expectHit(result).id).toBe("E-0002");
  });

  it("on equal similarity prefers an entry from the error's own project", () => {
    const result = run(error(words(10), { proj: "mine" }), [
      entry("E-0001", words(12), { meta: { proj: "theirs" } }),
      entry("E-0002", words(12)),
      entry("E-0003", words(12), { meta: { proj: "mine" } }),
    ]);
    expect(expectHit(result).id).toBe("E-0003");
  });

  it("then prefers the lowest ID, whatever the document order", () => {
    const result = run(error(words(10)), [
      entry("E-0010", words(12)),
      entry("E-0002", words(12), { meta: { proj: "mine" } }),
      entry("E-0007", words(12)),
    ]);
    expect(expectHit(result).id).toBe("E-0002");
  });

  it("breaks ties among exact hits the same way", () => {
    const result = run(error("boom", { proj: "mine" }), [
      entry("E-0001", "boom"),
      entry("E-0002", "boom", { meta: { proj: "mine" } }),
    ]);
    expect(expectHit(result)).toMatchObject({ id: "E-0002", via: "exact" });
  });

  it("breaks ties among code fallbacks the same way", () => {
    const short = (id: string) =>
      entry(id, `${id} gone`, { cat: "llm", code: "NO_ADAPTER" });
    const result = run(
      error("adapter missing", { category: "llm", code: "NO_ADAPTER" }),
      [short("E-0009"), short("E-0004")],
    );
    expect(expectHit(result)).toMatchObject({ id: "E-0004", via: "code" });
  });
});

describe("match: empty inputs", () => {
  it("misses against an empty knowledge base", () => {
    expect(match(error("boom"), [])).toEqual({ matched: false });
    expect(indexEntries([])).toEqual([]);
  });

  it("does not fuzzily match an empty message, even at a zero threshold", () => {
    expect(run(error(""), [entry("E-0001", "boom")], 0.01)).toEqual({
      matched: false,
    });
  });

  it("matches an empty message only exactly, to an entry recorded from one", () => {
    const result = run(error(""), [entry("E-0001", "", { title: "" })]);
    expect(expectHit(result).via).toBe("exact");
  });
});
