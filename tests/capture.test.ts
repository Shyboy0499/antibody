// Ported from dsh-errkb, tests/capture.test.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
import { describe, expect, it } from "vitest";
import {
  CAPTURE_SOURCES,
  CATEGORY_BY_SOURCE,
  COMMAND_MAX_CHARS,
  DEFAULT_CAPTURE_OPTIONS,
  HEADLINE_MAX_CHARS,
  PERMANENT_LLM_CODES,
  TRANSIENT_LLM_CODES,
  TransientCounter,
  classify,
  exitCode,
  extractHeadline,
  safeErrorText,
} from "../src/capture";
import type { CaptureInput, Classified } from "../src/capture";
import { indexEntries, match } from "../src/match";
import { signature } from "../src/signature";
import { parseDocument } from "../src/store";

// ---------------------------------------------------------------------------
// Fixtures

const TSC = [
  "src/index.ts(3,24): error TS2307: Cannot find module 'missing-pkg' or its corresponding type declarations.",
  "src/store.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/match.ts(42,1): error TS7006: Parameter 'x' implicitly has an 'any' type.",
  "",
  "Found 3 errors in 3 files.",
];

const PNPM = [
  "Progress: resolved 1, reused 0, downloaded 0, added 0",
  "Packages: +12",
  " WARN  deprecated inflight@1.0.6: This module is not supported",
  " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/missing-pkg: Not Found - 404",
  "",
  "This error happened while installing a direct dependency of <repo-root>",
].join("\n");

const TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "app/main.py", line 3, in <module>',
  "    raise ValueError(load())",
  '  File "app/loader.py", line 1, in load',
  "    import yaml",
  "ModuleNotFoundError: No module named 'yaml'",
  "",
].join("\n");

const fresh = () => new TransientCounter();

function run(
  input: CaptureInput,
  options: Parameters<typeof classify>[2] = {},
  counter = fresh(),
): Classified {
  const result = classify(input, counter, options);
  if (result === undefined) throw new Error("expected a classification");
  return result;
}

// ---------------------------------------------------------------------------

describe("constants", () => {
  it("names the four sources and their categories", () => {
    expect(CAPTURE_SOURCES).toEqual(["tool", "command", "llm", "agent"]);
    expect(CATEGORY_BY_SOURCE).toEqual({
      tool: "tool",
      command: "command-exit",
      llm: "llm",
      agent: "agent",
    });
  });

  it("splits the LLM codes as §6 does, with no overlap", () => {
    expect(PERMANENT_LLM_CODES).toEqual([
      "AUTH",
      "QUOTA",
      "INVALID_REQUEST",
      "CONTEXT_OVERFLOW",
      "NO_ADAPTER",
      "UNKNOWN",
    ]);
    expect(TRANSIENT_LLM_CODES).toEqual([
      "RATE_LIMIT",
      "SERVER",
      "TIMEOUT",
      "TRANSPORT",
      "EMPTY_RESPONSE",
    ]);
    const permanent = new Set<string>(PERMANENT_LLM_CODES);
    for (const code of TRANSIENT_LLM_CODES)
      expect(permanent.has(code)).toBe(false);
  });

  it("mirrors the defaults of the Settings table", () => {
    expect(DEFAULT_CAPTURE_OPTIONS).toEqual({
      capture: ["tool", "command", "llm", "agent"],
      captureExitCodes: true,
      transientThreshold: 5,
    });
  });
});

describe("extractHeadline", () => {
  it("returns a one-line message as it stands", () => {
    expect(extractHeadline("something went wrong")).toEqual({
      line: "something went wrong",
    });
  });

  it("extracts an errno code from a one-line message", () => {
    expect(
      extractHeadline("EPERM: operation not permitted, rename 'a' -> 'b'"),
    ).toEqual({
      line: "EPERM: operation not permitted, rename 'a' -> 'b'",
      code: "EPERM",
    });
  });

  it("extracts an exception class from a one-line message", () => {
    expect(extractHeadline("TypeError: x is not a function").code).toBe(
      "TypeError",
    );
  });

  it("picks the first tsc error and stores its TS code", () => {
    expect(extractHeadline(TSC.join("\n"))).toEqual({
      line: TSC[0],
      code: "TS2307",
    });
  });

  it("keeps the tsc headline when the later errors are reordered or added", () => {
    const [first, second, third, ...rest] = TSC;
    const reordered = [first, third, second, ...rest].join("\n");
    const more = [
      first,
      "src/extra.ts(1,1): error TS1005: ';' expected.",
      second,
      third,
      ...rest,
    ].join("\n");
    const base = extractHeadline(TSC.join("\n"));
    expect(extractHeadline(reordered)).toEqual(base);
    expect(extractHeadline(more)).toEqual(base);
    expect(signature("command-exit", extractHeadline(reordered).line)).toBe(
      signature("command-exit", base.line),
    );
  });

  it("picks the pnpm error line out of a log, digits and all", () => {
    expect(extractHeadline(PNPM)).toEqual({
      line: "ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/missing-pkg: Not Found - 404",
      code: "ERR_PNPM_FETCH_404",
    });
  });

  it("takes the last line of a Python traceback, not a quoted raise", () => {
    expect(extractHeadline(TRACEBACK)).toEqual({
      line: "ModuleNotFoundError: No module named 'yaml'",
      code: "ModuleNotFoundError",
    });
  });

  it("takes the last line of a traceback even when it names no code", () => {
    expect(
      extractHeadline(`${TRACEBACK}  File "x.py"\nKeyboardInterrupt\n`).line,
    ).toBe("KeyboardInterrupt");
  });

  it("falls back to the last non-empty line", () => {
    expect(
      extractHeadline("building...\ncompiling\nfailed to link\n\n"),
    ).toEqual({ line: "failed to link" });
  });

  it("skips log-level words that only look like codes", () => {
    expect(
      extractHeadline("npm ERR! code ENOENT\nnpm ERR! syscall open"),
    ).toEqual({ line: "npm ERR! code ENOENT", code: "ENOENT" });
    expect(extractHeadline("ERROR: build broke\nExit status 2")).toEqual({
      line: "Exit status 2",
    });
  });

  it("strips ANSI escapes and carriage returns before choosing", () => {
    expect(
      extractHeadline("\x1b[31mEACCES\x1b[0m: permission denied\r\nnext\r\n"),
    ).toEqual({ line: "EACCES: permission denied", code: "EACCES" });
    expect(extractHeadline("first\rsecond").line).toBe("second");
  });

  it("returns an empty headline for blank text", () => {
    expect(extractHeadline("")).toEqual({ line: "" });
    expect(extractHeadline(" \n\t\n")).toEqual({ line: "" });
  });

  it("caps a long headline with an ellipsis", () => {
    const long = `EPERM ${"x".repeat(500)}`;
    const { line, code } = extractHeadline(long);
    expect(Array.from(line)).toHaveLength(HEADLINE_MAX_CHARS);
    expect(line.endsWith("…")).toBe(true);
    expect(code).toBe("EPERM");
    expect(extractHeadline("y".repeat(HEADLINE_MAX_CHARS)).line).toHaveLength(
      HEADLINE_MAX_CHARS,
    );
  });

  it("does not take a code from the middle of a word", () => {
    expect(extractHeadline("THEEND reached").code).toBeUndefined();
  });
});

describe("exitCode", () => {
  it("reads the marker, and the last one when there are several", () => {
    expect(exitCode("out\n[exit code: 2]")).toBe(2);
    expect(exitCode("[exit code: 1]\nretry\n[exit code: 0]")).toBe(0);
  });

  it("is undefined without a marker", () => {
    expect(exitCode("all good")).toBeUndefined();
    expect(exitCode("[exit code: x]")).toBeUndefined();
  });
});

describe("safeErrorText", () => {
  it("reads an Error's message, name and code", () => {
    const error = Object.assign(new TypeError("bad thing"), { code: "E_BAD" });
    expect(safeErrorText(error)).toEqual({
      message: "bad thing",
      name: "TypeError",
      code: "E_BAD",
    });
  });

  it("reads a numeric code as text and ignores other code types", () => {
    expect(safeErrorText({ message: "m", code: 13 }).code).toBe("13");
    expect(safeErrorText({ message: "m", code: Number.NaN })).toEqual({
      message: "m",
    });
    expect(safeErrorText({ message: "m", code: { nested: 1 } })).toEqual({
      message: "m",
    });
    expect(safeErrorText({ message: "m", name: "" })).toEqual({ message: "m" });
  });

  it("takes a string as the message", () => {
    expect(safeErrorText("plain")).toEqual({ message: "plain" });
  });

  it("reads an object with a string message like an Error", () => {
    expect(
      safeErrorText({ message: "from a plain object", name: "X" }),
    ).toEqual({ message: "from a plain object", name: "X" });
  });

  it("stringifies a non-string message", () => {
    expect(safeErrorText({ message: { why: "nested" } })).toEqual({
      message: '{"why":"nested"}',
    });
  });

  it("stringifies primitives and nullish values", () => {
    expect(safeErrorText(undefined)).toEqual({ message: "undefined" });
    expect(safeErrorText(null)).toEqual({ message: "null" });
    expect(safeErrorText(42)).toEqual({ message: "42" });
    expect(safeErrorText(10n)).toEqual({ message: "10" });
    expect(safeErrorText(Symbol("s"))).toEqual({ message: "Symbol(s)" });
    expect(safeErrorText(() => 1)).toEqual({ message: "[function]" });
  });

  it("JSON-encodes a plain object without a message", () => {
    expect(safeErrorText({ status: 500 })).toEqual({
      message: '{"status":500}',
    });
  });

  it("survives a circular object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeErrorText(circular)).toEqual({ message: "[object Object]" });
  });

  it("survives throwing getters", () => {
    const hostile = {
      get message(): string {
        throw new Error("getter");
      },
      get name(): string {
        throw new Error("getter");
      },
      get code(): string {
        throw new Error("getter");
      },
      toJSON() {
        throw new Error("toJSON");
      },
      toString() {
        throw new Error("toString");
      },
    };
    expect(safeErrorText(hostile)).toEqual({ message: "[unprintable value]" });
  });

  it("survives a Proxy whose every trap throws", () => {
    const trap = () => {
      throw new Error("trap");
    };
    const proxy = new Proxy(
      {},
      {
        get: trap,
        has: trap,
        ownKeys: trap,
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
      },
    );
    expect(() => safeErrorText(proxy)).not.toThrow();
    expect(safeErrorText(proxy)).toEqual({ message: "[unprintable value]" });
  });

  it("handles an object with a null prototype", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.x = 1;
    expect(safeErrorText(bare)).toEqual({ message: '{"x":1}' });
  });

  it("falls back to String() when JSON gives nothing", () => {
    const silent = { toJSON: () => undefined, toString: () => "custom" };
    expect(safeErrorText(silent)).toEqual({ message: "custom" });
  });
});

describe("classify: the four sources", () => {
  it("LLM failure → category llm, the code, and the code leading the message", () => {
    const { decision, record, transient } = run({
      kind: "llm",
      code: "AUTH",
      message: "invalid api key",
    });
    expect(decision).toBe("record");
    expect(transient).toBe(false);
    expect(record).toEqual({
      category: "llm",
      code: "AUTH",
      message: "AUTH: invalid api key",
      raw: "invalid api key",
      title: "[llm] AUTH: invalid api key",
      displayCategory: "llm / AUTH",
      signature: signature("llm", "AUTH: invalid api key"),
    });
  });

  it("LLM failure: does not repeat a code the message already leads with", () => {
    const { record } = run({
      kind: "llm",
      code: "CONTEXT_OVERFLOW",
      message:
        "CONTEXT_OVERFLOW: the request exceeds the model's context window",
    });
    expect(record.message).toBe(
      "CONTEXT_OVERFLOW: the request exceeds the model's context window",
    );
  });

  it("LLM failure: normalizes the code and treats a blank one as UNKNOWN", () => {
    expect(run({ kind: "llm", code: " auth ", message: "x" }).record.code).toBe(
      "AUTH",
    );
    const blank = run({ kind: "llm", code: "  ", message: "" });
    expect(blank.record.code).toBe("UNKNOWN");
    expect(blank.record.message).toBe("UNKNOWN: (no message)");
    expect(blank.decision).toBe("record");
  });

  it("turn-level exception → category agent, name in the message, code kept", () => {
    const error = Object.assign(new RangeError("too deep"), {
      code: "E_DEPTH",
    });
    const { decision, record } = run({ kind: "agent", error });
    expect(decision).toBe("record");
    expect(record).toEqual({
      category: "agent",
      code: "E_DEPTH",
      message: "RangeError: too deep",
      raw: "RangeError: too deep",
      title: "[agent] RangeError: too deep",
      displayCategory: "agent",
      signature: signature("agent", "RangeError: too deep"),
    });
  });

  it("turn-level exception: a plain Error adds no name, and the code is extracted", () => {
    const { record } = run({
      kind: "agent",
      error: new Error("ENOENT: no such file or directory, open 'a.json'"),
    });
    expect(record.message).toBe(
      "ENOENT: no such file or directory, open 'a.json'",
    );
    expect(record.code).toBe("ENOENT");
  });

  it("turn-level exception: a name already leading the message is not repeated", () => {
    const { record } = run({
      kind: "agent",
      error: { name: "AbortError", message: "AbortError: aborted" },
    });
    expect(record.message).toBe("AbortError: aborted");
    expect(record.code).toBe("AbortError");
  });

  it("turn-level exception: anything thrown is captured, never rethrown", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const error of [undefined, null, 0, "text", circular, Symbol("s")])
      expect(run({ kind: "agent", error }).decision).toBe("record");
  });

  it("tool failure → category tool, the tool name kept for display", () => {
    const { decision, record } = run({
      kind: "tool",
      toolName: "pwsh",
      isError: true,
      message: "EPERM: operation not permitted, rename 'a' -> 'b'",
    });
    expect(decision).toBe("record");
    expect(record).toEqual({
      category: "tool",
      code: "EPERM",
      message: "EPERM: operation not permitted, rename 'a' -> 'b'",
      raw: "EPERM: operation not permitted, rename 'a' -> 'b'",
      title: "[tool:pwsh] EPERM: operation not permitted, rename 'a' -> 'b'",
      displayCategory: "tool / pwsh",
      signature: signature(
        "tool",
        "EPERM: operation not permitted, rename 'a' -> 'b'",
      ),
    });
  });

  it("tool failure: a given code wins over an extracted one; a blank one does not", () => {
    const base = { kind: "tool", toolName: "read", isError: true } as const;
    expect(
      run({ ...base, message: "ENOENT: gone", code: "NOT_FOUND" }).record.code,
    ).toBe("NOT_FOUND");
    expect(
      run({ ...base, message: "ENOENT: gone", code: " " }).record.code,
    ).toBe("ENOENT");
    expect(run({ ...base, message: "nope" }).record).not.toHaveProperty("code");
    expect(run({ ...base, message: "" }).record.title).toBe(
      "[tool:read] (no message)",
    );
  });

  it("tool result that is not an error → nothing", () => {
    expect(
      classify(
        { kind: "tool", toolName: "read", isError: false, message: "ok" },
        fresh(),
      ),
    ).toBeUndefined();
  });

  it("command non-zero exit → category command-exit, headline without the marker", () => {
    const text = `${TSC.join("\n")}\n[exit code: 2]`;
    const { decision, record } = run({ kind: "command", toolName: "sh", text });
    expect(decision).toBe("record");
    expect(record).toEqual({
      category: "command-exit",
      code: "TS2307",
      message: TSC[0],
      raw: text,
      title: `[command-exit:sh] ${TSC[0]}`,
      displayCategory: "command-exit / sh",
      signature: signature("command-exit", TSC[0] as string),
      exitCode: 2,
    });
  });

  it("command non-zero exit with no other output is still recorded", () => {
    const { record } = run({
      kind: "command",
      toolName: "sh",
      text: "\n[exit code: 127]\n",
    });
    expect(record.message).toBe("exit code 127");
    expect(record.exitCode).toBe(127);
    expect(record.raw).toBe("\n[exit code: 127]\n");
  });

  it("command: two different silent commands get two different signatures", () => {
    const silent = (command: string) =>
      run({ kind: "command", toolName: "sh", text: "[exit code: 1]", command })
        .record;
    const test = silent("pnpm test");
    const lint = silent("pnpm lint");
    expect(test.message).toBe("pnpm test → exit code 1");
    expect(test.title).toBe("[command-exit:sh] pnpm test → exit code 1");
    expect(lint.message).toBe("pnpm lint → exit code 1");
    expect(test.signature).not.toBe(lint.signature);
    expect(test.signature).toBe(
      signature("command-exit", "pnpm test → exit code 1"),
    );
  });

  it("command: the same silent command keeps its signature when only its directory changes", () => {
    const silent = (command: string) =>
      run({ kind: "command", toolName: "sh", text: "[exit code: 1]", command })
        .record.signature;
    expect(silent("cat /srv/app/build/one.txt")).toBe(
      silent("cat /var/tmp/other/one.txt"),
    );
  });

  it("command: a headline without a code is led by the command too", () => {
    const failed = (command: string) =>
      run({
        kind: "command",
        toolName: "sh",
        text: "1 test failed\n[exit code: 1]",
        command,
      }).record;
    expect(failed("pnpm test").message).toBe("pnpm test → 1 test failed");
    expect(failed("pnpm test").signature).not.toBe(
      failed("cargo test").signature,
    );
  });

  it("command: a code-bearing headline stands alone, whatever the command", () => {
    const text = `${TSC.join("\n")}\n[exit code: 2]`;
    const a = run({ kind: "command", toolName: "sh", text, command: "tsc" });
    const b = run({
      kind: "command",
      toolName: "sh",
      text,
      command: "pnpm tsc",
    });
    expect(a.record.message).toBe(TSC[0]);
    expect(a.record.code).toBe("TS2307");
    expect(a.record.signature).toBe(b.record.signature);
  });

  it("command: only the first non-blank line of the command, ANSI-free and capped", () => {
    const silent = (command: string) =>
      run({ kind: "command", toolName: "sh", text: "[exit code: 3]", command })
        .record.message;
    expect(silent("\n  \u001b[1mset -e\u001b[0m  \nmake all\n")).toBe(
      "set -e → exit code 3",
    );
    const long = silent(`echo ${"x".repeat(300)}`);
    expect(long.endsWith("… → exit code 3")).toBe(true);
    expect(Array.from(long.split(" → ")[0] as string)).toHaveLength(
      COMMAND_MAX_CHARS,
    );
    expect(silent("   \n\t")).toBe("exit code 3");
  });

  it("command: the headline ignores a marker in the middle of the output", () => {
    const { record } = run({
      kind: "command",
      toolName: "sh",
      text: "step one failed\n[exit code: 1]\ncleanup done\n[exit code: 1]",
    });
    expect(record.message).toBe("cleanup done");
  });

  it("command exit code 0 → nothing", () => {
    expect(
      classify(
        { kind: "command", toolName: "sh", text: "built\n[exit code: 0]" },
        fresh(),
      ),
    ).toBeUndefined();
  });

  it("command output without a marker → nothing", () => {
    expect(
      classify({ kind: "command", toolName: "sh", text: "EPERM" }, fresh()),
    ).toBeUndefined();
  });

  it("captureExitCodes: false → nothing for a non-zero exit", () => {
    expect(
      classify(
        { kind: "command", toolName: "sh", text: "boom\n[exit code: 1]" },
        fresh(),
        { captureExitCodes: false },
      ),
    ).toBeUndefined();
  });
});

describe("classify: transient errors and the threshold", () => {
  const rateLimit: CaptureInput = {
    kind: "llm",
    code: "RATE_LIMIT",
    message: "429 Too Many Requests",
  };

  it("permanent codes get an ID on the first occurrence", () => {
    for (const code of PERMANENT_LLM_CODES) {
      const counter = fresh();
      const result = run({ kind: "llm", code, message: "x" }, {}, counter);
      expect(result.decision).toBe("record");
      expect(result.transient).toBe(false);
      expect(result).not.toHaveProperty("count");
      expect(counter.count(result.record.signature)).toBe(0);
    }
  });

  it("an unknown code is treated as permanent", () => {
    const result = run({ kind: "llm", code: "BRAND_NEW", message: "x" });
    expect(result.decision).toBe("record");
    expect(result.transient).toBe(false);
  });

  it("transient codes are counted only until the threshold, then promoted exactly once", () => {
    for (const code of TRANSIENT_LLM_CODES) {
      const counter = fresh();
      const input: CaptureInput = { kind: "llm", code, message: "flaky" };
      const decisions = Array.from(
        { length: 8 },
        () => run(input, {}, counter).decision,
      );
      expect(decisions).toEqual([
        "count-only",
        "count-only",
        "count-only",
        "count-only",
        "record",
        "count-only",
        "count-only",
        "count-only",
      ]);
    }
  });

  it("reports the count and marks the promoting occurrence", () => {
    const counter = fresh();
    const results = Array.from({ length: 3 }, () =>
      run(rateLimit, { transientThreshold: 2 }, counter),
    );
    expect(results.map((r) => [r.count, r.promoted, r.transient])).toEqual([
      [1, false, true],
      [2, true, true],
      [3, false, true],
    ]);
  });

  it("counts per signature: different messages do not add up", () => {
    const counter = fresh();
    const other: CaptureInput = { ...rateLimit, message: "quota window reset" };
    for (let i = 0; i < 4; i++) run(rateLimit, {}, counter);
    expect(run(other, {}, counter).decision).toBe("count-only");
    expect(run(rateLimit, {}, counter).decision).toBe("record");
  });

  it("counts per session: a new counter starts from zero", () => {
    const first = fresh();
    for (let i = 0; i < 4; i++) run(rateLimit, {}, first);
    expect(run(rateLimit, {}, fresh()).decision).toBe("count-only");
    expect(run(rateLimit, {}, first).decision).toBe("record");
  });

  it("uses an injected Map as the counter's state", () => {
    const counts = new Map<string, number>();
    const counter = new TransientCounter(counts);
    const { record } = run(rateLimit, {}, counter);
    expect(counts.get(record.signature)).toBe(1);
    counts.set(record.signature, 4);
    expect(run(rateLimit, {}, counter).decision).toBe("record");
    expect(counter.count(record.signature)).toBe(5);
    expect(counter.count("never-seen")).toBe(0);
  });

  it("clamps the threshold to a whole number of at least 1", () => {
    for (const transientThreshold of [1, 0, -3, 0.2]) {
      const counter = fresh();
      expect(run(rateLimit, { transientThreshold }, counter).decision).toBe(
        "record",
      );
      expect(run(rateLimit, { transientThreshold }, counter).decision).toBe(
        "count-only",
      );
    }
    const counter = fresh();
    expect(run(rateLimit, { transientThreshold: 1.5 }, counter).decision).toBe(
      "count-only",
    );
    expect(run(rateLimit, { transientThreshold: 1.5 }, counter).decision).toBe(
      "record",
    );
  });

  it("falls back to the default threshold for a non-finite one", () => {
    const counter = fresh();
    const decisions = Array.from(
      { length: 5 },
      () =>
        run(rateLimit, { transientThreshold: Number.NaN }, counter).decision,
    );
    expect(decisions.at(-1)).toBe("record");
    expect(decisions.slice(0, 4)).toEqual(Array(4).fill("count-only"));
  });

  it("does not count a transient error whose source is off", () => {
    const counter = fresh();
    expect(classify(rateLimit, counter, { capture: ["tool"] })).toBeUndefined();
    expect(counter.count(run(rateLimit).record.signature)).toBe(0);
  });
});

describe("classify: the capture setting", () => {
  const inputs: CaptureInput[] = [
    { kind: "llm", code: "AUTH", message: "bad key" },
    { kind: "llm", code: "RATE_LIMIT", message: "slow down" },
    { kind: "agent", error: new Error("turn failed") },
    { kind: "tool", toolName: "pwsh", isError: true, message: "EPERM" },
    { kind: "command", toolName: "sh", text: "boom\n[exit code: 1]" },
  ];

  it("with every source off, produces zero records and counts nothing", () => {
    const counts = new Map<string, number>();
    const counter = new TransientCounter(counts);
    for (let i = 0; i < 10; i++)
      for (const input of inputs)
        expect(classify(input, counter, { capture: [] })).toBeUndefined();
    expect(counts.size).toBe(0);
  });

  it("turns each source off on its own", () => {
    for (const source of CAPTURE_SOURCES) {
      const capture = CAPTURE_SOURCES.filter((s) => s !== source);
      for (const input of inputs) {
        const result = classify(input, fresh(), {
          capture,
          transientThreshold: 1,
        });
        if (input.kind === source) expect(result).toBeUndefined();
        else expect(result?.decision).toBe("record");
      }
    }
  });

  it("ignores names it does not know", () => {
    expect(
      classify(inputs[0] as CaptureInput, fresh(), {
        capture: ["llm-typo", "command-exit"],
      }),
    ).toBeUndefined();
  });
});

describe("records feed match() and the store", () => {
  it("a recorded error matches its own entry exactly", () => {
    const { record } = run({
      kind: "tool",
      toolName: "pwsh",
      isError: true,
      message: "EPERM: operation not permitted, rename 'a' -> 'b'",
    });
    const document = parseDocument(
      [
        `## E-0001 · ${record.title}`,
        `<!-- antibody: sig=${record.signature} cat=${record.category} code=${record.code} first=2026-10-01T00:00:00Z -->`,
        "",
        `- Fingerprint: \`${record.signature}\``,
        `- Category: \`${record.displayCategory}\``,
        "- First seen: 2026-10-01 00:00 · Last seen: 2026-10-01 00:00 · Hits: 1",
        "- Trigger:",
        "- Raw message:",
        "  ```text",
        `  ${record.raw}`,
        "  ```",
        "- Fix:",
        "- Status: `open`",
        "- Notes:",
        "",
      ].join("\n"),
    );
    const result = match(
      record,
      indexEntries(document.blocks.map((b) => b.entry)),
    );
    expect(result).toMatchObject({ matched: true, id: "E-0001", via: "exact" });
  });

  it("reproduces the signature of a seed entry", () => {
    const { record } = run({
      kind: "llm",
      code: "NO_ADAPTER",
      message: "no adapter is registered for the configured provider",
    });
    expect(record.signature).toBe("bcf6cca60510");
  });
});
