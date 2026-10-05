// The event log: events.jsonl in the memory directory.
//
// Every agent appends one JSON line per event - an error it hit, a claim, a fix
// it recorded, a notice it received, an error it got past - and
// `antibody watch` tails the file. The
// log is the live record of the fleet; ANTIBODIES.md and state.json stay the
// source of truth for entries and counters.
//
// Concurrency. A line is appended with O_APPEND in one write and kept under
// EVENT_MAX_BYTES, so appends from several processes land whole, in some
// order, never interleaved, on a local filesystem. A reader that meets a line
// with no newline yet leaves it for its next read. A line that does not parse,
// or parses to the wrong shape, is skipped and counted, never thrown.
//
// Privacy. An event's free text goes through redact() before it is written.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname } from "node:path";
import { clip } from "./notice";
import type { NoticeKind } from "./notice";
import { redact } from "./redact";

/** The version every event line carries. */
export const EVENTS_VERSION = 1;

/** No line, newline included, is longer than this many bytes. */
export const EVENT_MAX_BYTES = 4096;

/** Agent names, session ids and entry ids are clipped to this many characters. */
export const EVENT_LABEL_MAX_CHARS = 200;

/** What an event records. */
export const EVENT_KINDS = [
  "hit",
  "miss",
  "claim",
  "hold",
  "release",
  "fix",
  "notice",
  "resolve",
  "forget",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** One line of events.jsonl. */
export interface MemoryEvent {
  v: typeof EVENTS_VERSION;
  /** When it happened, ISO 8601. */
  t: string;
  kind: EventKind;
  /** The agent's display name. */
  agent: string;
  /** The harness session it came from. */
  session: string;
  /** The entry it concerns, when there is one. */
  id?: string;
  /** Tokens spent or saved, when known. */
  tokens?: number;
  /**
   * For a notice: which one it was, a NoticeKind or `hold` for a claim hint.
   * Readers accept any string, so a newer writer can add kinds.
   */
  notice?: NoticeKind | "hold";
  /** A short description, redacted. */
  text?: string;
}

/** An event to append; the version and, by default, the time are filled in. */
export type NewEvent = Omit<MemoryEvent, "v" | "t"> & { t?: string };

/**
 * Whether a parsed value is a well-formed event.
 *
 * @param value - anything JSON.parse returned.
 */
export function isMemoryEvent(value: unknown): value is MemoryEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const e = value as Record<string, unknown>;
  const optionalString = (key: string) =>
    e[key] === undefined || typeof e[key] === "string";
  return (
    e.v === EVENTS_VERSION &&
    typeof e.t === "string" &&
    (EVENT_KINDS as readonly unknown[]).includes(e.kind) &&
    typeof e.agent === "string" &&
    typeof e.session === "string" &&
    optionalString("id") &&
    optionalString("text") &&
    optionalString("notice") &&
    (e.tokens === undefined ||
      (typeof e.tokens === "number" &&
        Number.isFinite(e.tokens) &&
        e.tokens >= 0))
  );
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * One event as a line of events.jsonl: redacted, clipped to fit
 * {@link EVENT_MAX_BYTES}, and ending in a newline.
 *
 * @param event - the event.
 * @param now - the time to stamp when the event has none.
 * @returns the line.
 */
export function encodeEvent(event: NewEvent, now: Date = new Date()): string {
  const base: MemoryEvent = {
    v: EVENTS_VERSION,
    t: event.t ?? now.toISOString(),
    kind: event.kind,
    agent: clip(event.agent, EVENT_LABEL_MAX_CHARS),
    session: clip(event.session, EVENT_LABEL_MAX_CHARS),
  };
  if (event.id !== undefined) base.id = clip(event.id, EVENT_LABEL_MAX_CHARS);
  if (event.tokens !== undefined) base.tokens = event.tokens;
  if (event.notice !== undefined) base.notice = event.notice;
  const line = (text: string | undefined) =>
    `${JSON.stringify(text === undefined ? base : { ...base, text })}\n`;
  if (event.text === undefined) return line(undefined);

  const text = redact(event.text);
  if (bytes(line(text)) <= EVENT_MAX_BYTES) return line(text);
  let low = 0;
  let high = Array.from(text).length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(line(clip(text, mid))) <= EVENT_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  return line(clip(text, low));
}

/** What a read of the log found. */
export interface EventBatch {
  events: MemoryEvent[];
  /** Complete lines that did not parse, or parsed to the wrong shape. */
  skipped: number;
}

/**
 * Parse complete lines of events.jsonl. Blank lines are ignored.
 *
 * @param text - whole lines, each ending in a newline.
 */
export function parseEvents(text: string): EventBatch {
  const batch: EventBatch = { events: [], skipped: 0 };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      batch.skipped++;
      continue;
    }
    if (isMemoryEvent(value)) batch.events.push(value);
    else batch.skipped++;
  }
  return batch;
}

/**
 * Append one event to the log, creating its directory when needed.
 *
 * @param file - the events.jsonl path.
 * @param event - the event.
 * @param now - the time to stamp when the event has none.
 */
export async function appendEvent(
  file: string,
  event: NewEvent,
  now: Date = new Date(),
): Promise<void> {
  // Synchronous for the same reason as nodeStoreFs() in store.ts: the
  // promise API costs a hook its start-up time. Appends use O_APPEND, so lines
  // from concurrent writers never interleave.
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, encodeEvent(event, now));
}

/** A read of the log from a byte offset, and where the next read starts. */
export interface EventTail extends EventBatch {
  offset: number;
}

/**
 * Read the events appended since `offset`. Only complete lines are read; the
 * returned offset stops before a line that is still being written. A missing
 * file reads as empty, and an offset past the end (the file was replaced)
 * starts again from the beginning.
 *
 * @param file - the events.jsonl path.
 * @param offset - where the previous read stopped; 0 for the whole log.
 */
export async function readEventsFrom(
  file: string,
  offset = 0,
): Promise<EventTail> {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { events: [], skipped: 0, offset: 0 };
  }
  try {
    const { size } = fstatSync(fd);
    const start = offset > size ? 0 : offset;
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const complete = buffer.lastIndexOf(0x0a) + 1;
    const batch = parseEvents(buffer.subarray(0, complete).toString("utf8"));
    return { ...batch, offset: start + complete };
  } finally {
    closeSync(fd);
  }
}
