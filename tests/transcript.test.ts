import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MemoryEvent } from "../src/events";
import {
  TRANSCRIPT_MAX_BYTES,
  diagnosisTokens,
  tokensBetween,
  transcriptTokens,
} from "../src/transcript";

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 6, 10, minute)).toISOString();
const SINCE = new Date(at(10));
const UNTIL = new Date(at(20));
const jsonl = (...records: unknown[]) =>
  `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

// The shapes each harness writes, cut down to what the reader looks at.
const claude = (
  minute: number,
  id: string,
  usage: Record<string, number>,
  block = "text",
) => ({
  type: "assistant",
  timestamp: at(minute),
  requestId: `req_${id}`,
  message: { id, role: "assistant", content: [{ type: block }], usage },
});
const codex = (minute: number, total: Record<string, number> | null) => ({
  timestamp: at(minute),
  type: "event_msg",
  payload: {
    type: "token_count",
    info: total === null ? null : { total_token_usage: total },
  },
});
const gemini = (
  minute: number,
  id: string,
  tokens?: Record<string, number>,
) => ({
  id,
  timestamp: at(minute),
  type: "gemini",
  content: "",
  ...(tokens === undefined ? {} : { tokens }),
});

describe("tokensBetween: Claude Code", () => {
  it("counts each message once, though every content block repeats its usage", () => {
    const usage = {
      input_tokens: 3,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 40_000,
      output_tokens: 200,
    };
    const text = jsonl(
      { type: "user", timestamp: at(11), message: { role: "user" } },
      claude(12, "msg_1", usage, "thinking"),
      claude(12, "msg_1", usage, "text"),
      claude(12, "msg_1", usage, "tool_use"),
      claude(15, "msg_2", { input_tokens: 10, output_tokens: 90 }),
    );
    // 3 + 500 + 200 for msg_1, cache reads left out, then 100 for msg_2.
    expect(tokensBetween(text, SINCE, UNTIL)).toBe(803);
  });

  it("keeps to the window, both ends included", () => {
    const u = { input_tokens: 1, output_tokens: 9 };
    const text = jsonl(
      claude(9, "before", u),
      claude(10, "first", u),
      claude(20, "last", u),
      claude(21, "after", u),
    );
    expect(tokensBetween(text, SINCE, UNTIL)).toBe(20);
  });

  it("falls back to the request id, then counts a message with neither", () => {
    const u = { output_tokens: 5 };
    const text = jsonl(
      {
        type: "assistant",
        timestamp: at(12),
        requestId: "r1",
        message: { usage: u },
      },
      {
        type: "assistant",
        timestamp: at(12),
        requestId: "r1",
        message: { usage: u },
      },
      { type: "assistant", timestamp: at(13), message: { usage: u } },
      { type: "assistant", timestamp: at(13), message: { usage: u } },
    );
    expect(tokensBetween(text, SINCE, UNTIL)).toBe(15);
  });

  it("reads a missing or malformed count as none", () => {
    const text = jsonl(
      claude(12, "m", { input_tokens: -4, output_tokens: Number.NaN }),
      claude(13, "n", { output_tokens: 7 }),
    );
    expect(tokensBetween(text.replace('"NaN"', "null"), SINCE, UNTIL)).toBe(7);
  });
});

describe("tokensBetween: Codex CLI", () => {
  it("costs a window the difference of the running totals around it", () => {
    const text = jsonl(
      { timestamp: at(1), type: "session_meta", payload: { id: "s" } },
      codex(5, {
        input_tokens: 1_000,
        cached_input_tokens: 400,
        output_tokens: 100,
        total_tokens: 1_100,
      }),
      codex(12, {
        input_tokens: 3_000,
        cached_input_tokens: 1_500,
        output_tokens: 300,
        total_tokens: 3_300,
      }),
      codex(18, {
        input_tokens: 5_000,
        cached_input_tokens: 2_000,
        output_tokens: 600,
        total_tokens: 5_600,
      }),
      codex(25, {
        input_tokens: 9_000,
        cached_input_tokens: 2_000,
        output_tokens: 900,
        total_tokens: 9_900,
      }),
    );
    // (5600 - 2000) - (1100 - 400): what was new between minute 10 and 20.
    expect(tokensBetween(text, SINCE, UNTIL)).toBe(2_900);
  });

  it("starts from nothing when the session began inside the window", () => {
    const text = jsonl(
      codex(12, {
        input_tokens: 800,
        cached_input_tokens: 0,
        output_tokens: 200,
      }),
    );
    expect(tokensBetween(text, SINCE, UNTIL)).toBe(1_000);
  });

  it("skips a count with no usage yet, and reads none after the window", () => {
    const text = jsonl(
      codex(11, null),
      {
        timestamp: at(12),
        type: "event_msg",
        payload: { type: "token_count" },
      },
      codex(25, { total_tokens: 50 }),
    );
    expect(tokensBetween(text, SINCE, UNTIL)).toBeUndefined();
  });
});

describe("tokensBetween: Gemini CLI", () => {
  it("counts the last record of each message, less what was cached", () => {
    const text = jsonl(
      {
        sessionId: "s",
        projectHash: "p",
        startTime: at(1),
        lastUpdated: at(1),
      },
      { id: "u1", timestamp: at(11), type: "user", content: "fix it" },
      gemini(12, "g1"),
      gemini(12, "g1", {
        input: 900,
        output: 100,
        cached: 600,
        thoughts: 50,
        tool: 0,
        total: 1_050,
      }),
      { $set: { lastUpdated: at(12) } },
      gemini(14, "g2", { input: 300, output: 20, cached: 0 }),
    );
    // g1: 1050 - 600, then g2 from its parts: 300 + 20.
    expect(tokensBetween(text, SINCE, UNTIL)).toBe(770);
  });

  it("reads the older single-document transcript the same way", () => {
    const text = JSON.stringify({
      sessionId: "s",
      messages: [
        gemini(5, "early", { total: 999 }),
        gemini(12, "g1", { total: 400, cached: 100 }),
        { timestamp: at(13), type: "gemini", tokens: { total: 50 } },
      ],
    });
    expect(tokensBetween(text, SINCE, UNTIL)).toBe(350);
  });
});

describe("tokensBetween: a transcript being written", () => {
  it("skips a last line that is not finished yet", () => {
    const text = `${jsonl(claude(12, "m", { output_tokens: 6 }))}{"type":"assistant","message":{"usage":{"output_tok`;
    expect(tokensBetween(text, SINCE, UNTIL)).toBe(6);
  });
});

describe("tokensBetween: what it cannot read", () => {
  it("gives undefined for an unknown format, an empty file, or a quiet window", () => {
    expect(
      tokensBetween("not json\n{also not\n", SINCE, UNTIL),
    ).toBeUndefined();
    expect(tokensBetween("", SINCE, UNTIL)).toBeUndefined();
    expect(
      tokensBetween(jsonl({ tokens: 5 }, [1, 2]), SINCE, UNTIL),
    ).toBeUndefined();
    expect(
      tokensBetween(
        jsonl(claude(30, "late", { output_tokens: 5 })),
        SINCE,
        UNTIL,
      ),
    ).toBeUndefined();
    expect(
      tokensBetween(JSON.stringify({ messages: [] }), SINCE, UNTIL),
    ).toBeUndefined();
    expect(
      tokensBetween(
        jsonl({
          type: "assistant",
          timestamp: "yesterday",
          message: { usage: {} },
        }),
        SINCE,
        UNTIL,
      ),
    ).toBeUndefined();
  });
});

describe("transcriptTokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "antibody-transcript-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the file the hook named", () => {
    const file = join(dir, "session.jsonl");
    writeFileSync(file, jsonl(claude(12, "m", { output_tokens: 42 })));
    expect(transcriptTokens(file, SINCE, UNTIL)).toBe(42);
  });

  it("fails open on a missing or oversized file", () => {
    expect(
      transcriptTokens(join(dir, "gone.jsonl"), SINCE, UNTIL),
    ).toBeUndefined();
    const big = join(dir, "big.jsonl");
    writeFileSync(big, "");
    truncateSync(big, TRANSCRIPT_MAX_BYTES + 1);
    expect(transcriptTokens(big, SINCE, UNTIL)).toBeUndefined();
  });
});

describe("diagnosisTokens", () => {
  const claim = (
    agent: string,
    minute: number,
    extra: Partial<MemoryEvent> = {},
  ): MemoryEvent => ({
    v: 1,
    t: at(minute),
    kind: "claim",
    agent,
    session: `s-${agent}`,
    id: "E-0001",
    transcript: `/tmp/${agent}.jsonl`,
    ...extra,
  });
  // A reader that says whose transcript it read, and from when.
  const reads: string[] = [];
  const read = (path: string, since: Date, until: Date) => {
    reads.push(`${path} ${since.toISOString()} ${until.toISOString()}`);
    return 1_234.4;
  };

  it("measures the recording agent's own claim, to the moment of the fix", () => {
    reads.length = 0;
    const events = [
      claim("a", 10),
      claim("b", 12),
      claim("a", 14, { id: "E-0002" }),
    ];
    expect(diagnosisTokens(events, "E-0001", "a", UNTIL, read)).toBe(1_234);
    expect(reads).toEqual([`/tmp/a.jsonl ${at(10)} ${at(20)}`]);
  });

  it("falls back to the latest claim with a transcript", () => {
    reads.length = 0;
    const events = [
      claim("b", 11),
      claim("c", 12),
      claim("d", 13, { transcript: undefined }),
      { ...claim("e", 14), kind: "hit" as const },
    ];
    expect(diagnosisTokens(events, "E-0001", "a", UNTIL, read)).toBe(1_234);
    expect(reads).toEqual([`/tmp/c.jsonl ${at(12)} ${at(20)}`]);
  });

  it("measures nothing without a claim, with a bad time, or with nothing spent", () => {
    expect(diagnosisTokens([], "E-0001", "a", UNTIL, read)).toBeUndefined();
    expect(
      diagnosisTokens(
        [claim("a", 10, { t: "soon" })],
        "E-0001",
        "a",
        UNTIL,
        read,
      ),
    ).toBeUndefined();
    expect(
      diagnosisTokens([claim("a", 30)], "E-0001", "a", UNTIL, read),
    ).toBeUndefined();
    for (const result of [undefined, 0])
      expect(
        diagnosisTokens([claim("a", 10)], "E-0001", "a", UNTIL, () => result),
      ).toBeUndefined();
  });

  it("reads the transcript file by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "antibody-diagnosis-"));
    const file = join(dir, "a.jsonl");
    writeFileSync(file, jsonl(claude(15, "m", { output_tokens: 77 })));
    expect(
      diagnosisTokens(
        [claim("a", 10, { transcript: file })],
        "E-0001",
        "a",
        UNTIL,
      ),
    ).toBe(77);
    rmSync(dir, { recursive: true, force: true });
  });
});
