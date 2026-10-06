// What a diagnosis cost, read from the agent's own transcript (design §8).
//
// Every harness antibody serves hands its hooks a `transcript_path`, and each
// writes the model's token usage into that file. Summing it between the moment
// an agent claimed an error and the moment its fix was recorded gives what the
// diagnosis cost, which is what every later agent that gets the fix pushed
// saves. Without a transcript, or one this reader does not understand, the
// cost stays unknown and callers fall back to the assumed 800 tokens.
//
// "Tokens" here means what the model newly read or wrote: input, cache writes
// and output, but not the context it re-read from its prompt cache on every
// turn. That is the same measure as a notice's tokens - text added to the
// context once - so the two can be subtracted.
//
// The three formats, read off each harness's own writer:
//
// - Claude Code: JSON lines, one per content block. An assistant line carries
//   `message.usage`, repeated on every line of the same message, so a message
//   is counted once, by its `message.id`.
// - Codex CLI (0.160.1): JSON lines `{timestamp, type, payload}`. An
//   `event_msg` whose payload is a `token_count` carries the session's running
//   total in `info.total_token_usage`, so a window costs the difference of two
//   totals.
// - Gemini CLI (0.62.0): JSON lines - a metadata line, then message records,
//   each appended again whenever it changes - whose `gemini` messages carry
//   `tokens`. The last record of a message counts. Older versions wrote one
//   JSON document with a `messages` array, which reads the same way.
//
// Pure apart from transcriptTokens(), which reads the file and never throws.
import type { MemoryEvent } from "./events";
import { nodeFs } from "./lazy";

/** A transcript larger than this is not read. */
export const TRANSCRIPT_MAX_BYTES = 128 * 1024 * 1024;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A count, or 0 for anything that is not a finite, non-negative number. */
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** The time in a record's field, or undefined. */
const timeOf = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
};

/** Claude Code: uncached input, cache writes and output. */
function claudeTokens(usage: Json): number {
  return (
    count(usage.input_tokens) +
    count(usage.cache_creation_input_tokens) +
    count(usage.output_tokens)
  );
}

/** Codex CLI: a running total, less what was read from the cache. */
function codexTotal(usage: Json): number {
  const total =
    usage.total_tokens === undefined
      ? count(usage.input_tokens) + count(usage.output_tokens)
      : count(usage.total_tokens);
  return Math.max(0, total - count(usage.cached_input_tokens));
}

/** Gemini CLI: everything the turn counted, less what was cached. */
function geminiTokens(tokens: Json): number {
  const total =
    tokens.total === undefined
      ? count(tokens.input) +
        count(tokens.output) +
        count(tokens.thoughts) +
        count(tokens.tool)
      : count(tokens.total);
  return Math.max(0, total - count(tokens.cached));
}

// Lines worth parsing: the rest of a transcript is conversation text.
const MAY_COUNT = /"usage"|"token_count"|"tokens"/;

/**
 * The tokens a transcript records between two moments.
 *
 * @param text - the transcript file's contents.
 * @param since - the start of the window, inclusive.
 * @param until - the end of the window, inclusive.
 * @returns the tokens, or undefined when nothing in the window could be read:
 *   an unknown format, or no usage recorded between the two moments.
 */
export function tokensBetween(
  text: string,
  since: Date,
  until: Date,
): number | undefined {
  const from = since.getTime();
  const to = until.getTime();
  const inWindow = (t: number | undefined) =>
    t !== undefined && t >= from && t <= to;

  // Claude Code and Gemini: per message, the last usage seen.
  const messages = new Map<string, number>();
  let anonymous = 0;
  let found = false;
  // Codex: the running total before the window, and the last inside it.
  let codexBefore = 0;
  let codexLast: number | undefined;

  const gemini = (record: Json) => {
    if (record.type !== "gemini" || !isObject(record.tokens)) return;
    if (!inWindow(timeOf(record.timestamp))) return;
    found = true;
    const tokens = geminiTokens(record.tokens);
    if (typeof record.id === "string") messages.set(`g:${record.id}`, tokens);
    else anonymous += tokens;
  };

  // A whole JSON document: Gemini CLI before it wrote JSON lines.
  const document = parseDocument(text);
  if (document !== undefined) {
    for (const record of document) if (isObject(record)) gemini(record);
    return found ? sum(messages) + anonymous : undefined;
  }

  for (const line of text.split("\n")) {
    if (!MAY_COUNT.test(line)) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;

    // Claude Code.
    const message = record.message;
    if (
      record.type === "assistant" &&
      isObject(message) &&
      isObject(message.usage)
    ) {
      if (!inWindow(timeOf(record.timestamp))) continue;
      found = true;
      const tokens = claudeTokens(message.usage);
      const id =
        typeof message.id === "string"
          ? message.id
          : typeof record.requestId === "string"
            ? record.requestId
            : undefined;
      if (id === undefined) anonymous += tokens;
      else messages.set(`c:${id}`, tokens);
      continue;
    }

    // Codex CLI.
    const payload = record.payload;
    if (
      record.type === "event_msg" &&
      isObject(payload) &&
      payload.type === "token_count"
    ) {
      const info = payload.info;
      if (!isObject(info) || !isObject(info.total_token_usage)) continue;
      const t = timeOf(record.timestamp);
      if (t === undefined || t > to) continue;
      const total = codexTotal(info.total_token_usage);
      if (t < from) codexBefore = total;
      else codexLast = total;
      continue;
    }

    // Gemini CLI.
    gemini(record);
  }

  if (codexLast !== undefined) {
    found = true;
    anonymous += Math.max(0, codexLast - codexBefore);
  }
  return found ? sum(messages) + anonymous : undefined;
}

const sum = (values: Map<string, number>) => {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
};

/** The messages of a transcript written as one JSON document, if it is one. */
function parseDocument(text: string): unknown[] | undefined {
  const start = text.trimStart();
  if (!start.startsWith("{")) return undefined;
  // JSON lines hold more than one value; only a whole document parses.
  try {
    const value: unknown = JSON.parse(start);
    return isObject(value) && Array.isArray(value.messages)
      ? value.messages
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tokens an agent's transcript records between two moments, read from its
 * file. Fails open: a missing, unreadable or oversized file gives undefined.
 *
 * @param path - the transcript, as the harness's hook named it.
 * @param since - the start of the window.
 * @param until - the end of the window.
 */
export function transcriptTokens(
  path: string,
  since: Date,
  until: Date,
): number | undefined {
  try {
    if (nodeFs.statSync(path).size > TRANSCRIPT_MAX_BYTES) return undefined;
    return tokensBetween(nodeFs.readFileSync(path, "utf8"), since, until);
  } catch {
    return undefined;
  }
}

/**
 * What diagnosing an entry cost: the tokens the claimant's transcript records
 * from its claim to `until`. The claim event names the transcript (the hook
 * recorded it); the claim made by `agent` is preferred, since it is the agent
 * recording the fix, and otherwise the latest claim with a transcript. It is
 * an upper bound when the claimant did other work in between.
 *
 * @param events - events.jsonl, oldest first.
 * @param id - the entry whose fix is being recorded.
 * @param agent - the agent recording it.
 * @param until - when the fix was recorded.
 * @param read - reads a transcript; transcriptTokens() by default.
 * @returns whole tokens, or undefined when nothing could be measured.
 */
export function diagnosisTokens(
  events: readonly MemoryEvent[],
  id: string,
  agent: string,
  until: Date,
  read: typeof transcriptTokens = transcriptTokens,
): number | undefined {
  let latest: MemoryEvent | undefined;
  let mine: MemoryEvent | undefined;
  for (const event of events) {
    if (event.kind !== "claim" || event.id !== id) continue;
    if (event.transcript === undefined) continue;
    latest = event;
    if (event.agent === agent) mine = event;
  }
  const claim = mine ?? latest;
  if (claim === undefined) return undefined;
  const since = new Date(claim.t);
  if (Number.isNaN(since.getTime()) || since > until) return undefined;
  const tokens = read(claim.transcript as string, since, until);
  // Nothing spent is no measurement: the transcript was not the diagnosis.
  return tokens === undefined || tokens <= 0 ? undefined : Math.round(tokens);
}
