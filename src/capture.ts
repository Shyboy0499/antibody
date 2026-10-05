// Ported from dsh-errkb, src/capture.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
// What a captured error is, and whether it deserves an ID (§6).
//
// Four sources reach the plugin, each wired to a hook by a later task (T11
// wires `agent/error` and `tools/result`, T16 wires `agent/request-error`).
// This module never registers anything: it takes plain input shapes, one per
// source, and turns each into a record ready for match() and store.append(),
// plus a decision - `record` (may take an ID now) or `count-only`.
//
// The decision is the noise rule of §6. Tool failures, non-zero exits,
// turn-level exceptions and permanent LLM failures take an ID immediately.
// Transient LLM failures (rate limits, server errors, timeouts) are only
// counted, per session and per signature, and promoted exactly once, when the
// count reaches `transientThreshold`. The decision only gates whether a miss may
// create an entry; matching an entry that already exists is up to the caller.
//
// Multi-line output goes through the headline extractor of
// docs/discussions.md §2a (decided): one line is picked as the message, so a
// fortieth `tsc` error or a reordered log does not change the signature, and
// the full text is kept as the raw sample.
//
// Everything here is pure apart from TransientCounter, whose state is a Map the
// caller owns and can inject.
import { ANSI, signature } from "./signature";

/** The capture sources, as named by the `capture` setting. */
export const CAPTURE_SOURCES = ["tool", "command", "llm", "agent"] as const;

/** One capture source. */
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/** The category each source records under, as passed to signature(). */
export const CATEGORY_BY_SOURCE = {
  tool: "tool",
  command: "command-exit",
  llm: "llm",
  agent: "agent",
} as const satisfies Record<CaptureSource, string>;

/** LLM failure codes whose fix is a configuration change: an ID at once. */
export const PERMANENT_LLM_CODES = [
  "AUTH",
  "QUOTA",
  "INVALID_REQUEST",
  "CONTEXT_OVERFLOW",
  "NO_ADAPTER",
  "UNKNOWN",
] as const;

/** LLM failure codes that go away by themselves: counted, promoted late. */
export const TRANSIENT_LLM_CODES = [
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  "EMPTY_RESPONSE",
] as const;

const TRANSIENT = new Set<string>(TRANSIENT_LLM_CODES);

/** A headline longer than this is cut, with an ellipsis. */
export const HEADLINE_MAX_CHARS = 200;

/** A command quoted in a headline is cut to this many characters first. */
export const COMMAND_MAX_CHARS = 120;

/** Capture settings; every one has a default. */
export interface CaptureOptions {
  /** The sources to capture (the `capture` setting); anything else is ignored. */
  capture: readonly string[];
  /** Record commands that exited non-zero (the `captureExitCodes` setting). */
  captureExitCodes: boolean;
  /** Occurrences in one session before a transient error earns an ID. */
  transientThreshold: number;
}

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  capture: CAPTURE_SOURCES,
  captureExitCodes: true,
  transientThreshold: 5,
};

/** An LLM request that failed (`agent/request-error`, T16). */
export interface LlmFailureInput {
  kind: "llm";
  /** The harness failure code, e.g. `RATE_LIMIT` or `AUTH`. */
  code: string;
  message: string;
}

/** A turn that threw (`agent/error`, T11); the error is whatever was thrown. */
export interface AgentErrorInput {
  kind: "agent";
  error: unknown;
}

/** A tool result (`tools/result`, T11) flagged as an error. */
export interface ToolFailureInput {
  kind: "tool";
  toolName: string;
  isError: boolean;
  message: string;
  /** `result.error.info.code`, when the tool gave one. */
  code?: string;
}

/** A tool result's text, sniffed for an `[exit code: N]` marker (T11). */
export interface CommandResultInput {
  kind: "command";
  toolName: string;
  text: string;
  /**
   * The command that ran, from the tool call's arguments, when the hook can
   * find one. Without it, every silent failure of one shell tool would read
   * `exit code N` and share one ID.
   */
  command?: string;
}

/** Anything capture can be handed. */
export type CaptureInput =
  LlmFailureInput | AgentErrorInput | ToolFailureInput | CommandResultInput;

/** A classified error, ready for match() and store.append(). */
export interface CaptureRecord {
  /** The category, e.g. `tool` or `command-exit`; `cat=` in the document. */
  category: string;
  /** A stable code such as `EPERM`, `TS2307` or `AUTH`, when there is one. */
  code?: string;
  /** The headline: the one line the signature is computed from. */
  message: string;
  /** The full text, for the raw sample; the store redacts and caps it. */
  raw: string;
  /** The entry title, e.g. `[tool:pwsh] EPERM: operation not permitted`. */
  title: string;
  /** The display category, e.g. `tool / pwsh` or `llm / AUTH`. */
  displayCategory: string;
  /** signature(category, message). */
  signature: string;
  /** The exit code, for `command-exit` only. */
  exitCode?: number;
}

/** What the caller may do with a classified error. */
export type CaptureDecision = "record" | "count-only";

/** The outcome of classify() for an error that is captured at all. */
export interface Classified {
  /** `record`: a miss may take an ID now. `count-only`: it may not. */
  decision: CaptureDecision;
  record: CaptureRecord;
  /** True for a transient error. */
  transient: boolean;
  /** Occurrences of this signature this session; transient errors only. */
  count?: number;
  /** True on the one occurrence that promoted a transient error. */
  promoted?: boolean;
}

// ---------------------------------------------------------------------------
// Safe stringify

/** What can be read off a thrown value without risking a second throw. */
export interface ErrorText {
  message: string;
  name?: string;
  code?: string;
}

/** Run a getter-like function; a throw yields `undefined`. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** A string or finite number as text; anything else is ignored. */
function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Text for any value: JSON for plain data, `String()` otherwise, and a fixed
 * placeholder when both throw (circular objects, hostile `toString`).
 */
function text(value: unknown): string {
  if (typeof value === "function") return "[function]";
  if (typeof value === "object" && value !== null) {
    const json = attempt(() => JSON.stringify(value));
    if (typeof json === "string") return json;
  }
  return attempt(() => String(value)) ?? "[unprintable value]";
}

/**
 * Read a thrown value safely (§6, `agent/error`): an Error gives its message,
 * name and code; a string is the message; an object with a string `message`
 * reads like an Error; anything else is stringified. Never throws - not on
 * circular objects, throwing getters or a Proxy whose every trap throws.
 *
 * @param error - whatever was thrown.
 * @returns the message, plus a name and code when there are any.
 */
export function safeErrorText(error: unknown): ErrorText {
  if (typeof error === "string") return { message: error };
  if (typeof error !== "object" || error === null)
    return { message: text(error) };

  const message = attempt(() => (error as { message?: unknown }).message);
  const name = scalar(attempt(() => (error as { name?: unknown }).name));
  const code = scalar(attempt(() => (error as { code?: unknown }).code));
  const extras = {
    ...(name === undefined ? {} : { name }),
    ...(code === undefined ? {} : { code }),
  };
  if (typeof message === "string") return { message, ...extras };
  if (message !== undefined) return { message: text(message), ...extras };
  return { message: text(error), ...extras };
}

// ---------------------------------------------------------------------------
// Headline extraction (docs/discussions.md §2a)

/**
 * A line that names its error: a Node/pnpm code (`ERR_PNPM_…`), an errno
 * (`EPERM`), an exception class (`ModuleNotFoundError`) or a TypeScript error
 * (`error TS2307`). ERR_ codes may carry digits (`ERR_PNPM_FETCH_404`).
 */
const CODE = /\b(?:ERR_[A-Z0-9_]+|E[A-Z]{2,}|[A-Z]\w*Error|error TS\d+)\b/g;

// Log-level words that fit `E[A-Z]{2,}` but name no error: `npm ERR! code
// ENOENT` must yield ENOENT, not ERR.
const NOT_A_CODE = new Set(["ERR", "ERROR", "ERRORS", "EXIT"]);

const TRACEBACK = "Traceback (most recent call last):";

/** The first real code in a line, as stored: `error TS2307` → `TS2307`. */
function codeIn(line: string): string | undefined {
  for (const [found] of line.matchAll(CODE)) {
    if (NOT_A_CODE.has(found)) continue;
    return found.startsWith("error ") ? found.slice("error ".length) : found;
  }
  return undefined;
}

/** Cut a line to `max` characters, the last one an ellipsis. */
function cap(line: string, max = HEADLINE_MAX_CHARS): string {
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/** The headline of a text, and the code it names. */
export interface Headline {
  line: string;
  code?: string;
}

/**
 * Pick the one line of a (possibly multi-line) error text that identifies it
 * (docs/discussions.md §2a):
 *
 * 1. a Python traceback gives its last non-empty line, the exception itself;
 * 2. otherwise the first line naming a code (see {@link CODE});
 * 3. otherwise the last non-empty line.
 *
 * The traceback rule runs first because a traceback quotes source lines, and a
 * quoted `raise ValueError(...)` would otherwise win rule 2. ANSI escapes are
 * stripped, lines are trimmed and the result is capped at
 * {@link HEADLINE_MAX_CHARS}.
 *
 * @param raw - the full text.
 * @returns the headline, empty for blank text, and its code if it names one.
 */
export function extractHeadline(raw: string): Headline {
  const lines = raw
    .replace(ANSI, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines.at(-1) ?? "";
  const pick = (line: string): Headline => {
    const code = codeIn(line);
    return { line: cap(line), ...(code === undefined ? {} : { code }) };
  };
  if (raw.includes(TRACEBACK)) return pick(last);
  return pick(lines.find((line) => codeIn(line) !== undefined) ?? last);
}

// ---------------------------------------------------------------------------
// Command exits

// `[exit code: N]`, as the harness appends it to a shell tool's result.
const EXIT_MARKER = /\[exit code: (\d+)\]/g;

/**
 * The exit code a tool result reports, from its last `[exit code: N]` marker.
 *
 * @param text - the tool result text.
 * @returns N, or `undefined` when there is no marker.
 */
export function exitCode(text: string): number | undefined {
  const markers = Array.from(text.matchAll(EXIT_MARKER));
  const last = markers.at(-1);
  return last === undefined ? undefined : Number(last[1]);
}

// ---------------------------------------------------------------------------
// Transient counter

/**
 * Per-session occurrence counts of transient errors, by signature. T11 holds
 * one per session; the Map is injectable so a test or a caller can see it.
 */
export class TransientCounter {
  constructor(private readonly counts: Map<string, number> = new Map()) {}

  /** Count one more occurrence; returns the new count. */
  bump(sig: string): number {
    const next = (this.counts.get(sig) ?? 0) + 1;
    this.counts.set(sig, next);
    return next;
  }

  /** Occurrences so far, 0 for a signature never seen. */
  count(sig: string): number {
    return this.counts.get(sig) ?? 0;
  }
}

/**
 * The `transientThreshold` actually applied: a whole number of at least 1.
 * index.ts reports a setting this changes; this stays the one rule for it.
 */
export function effectiveTransientThreshold(value: number): number {
  if (!Number.isFinite(value))
    return DEFAULT_CAPTURE_OPTIONS.transientThreshold;
  return Math.max(1, Math.ceil(value));
}

// ---------------------------------------------------------------------------
// Classification

const NO_MESSAGE = "(no message)";

/** Build a record from a source's category, tag and full text. */
function build(
  category: string,
  tag: string,
  displayCategory: string,
  raw: string,
  code: string | undefined,
  prefix = "",
  headline: Headline = extractHeadline(raw),
): CaptureRecord {
  const finalCode = code ?? headline.code;
  const line = headline.line === "" ? NO_MESSAGE : headline.line;
  const message =
    prefix !== "" && !line.startsWith(prefix) ? `${prefix}: ${line}` : line;
  return {
    category,
    ...(finalCode === undefined ? {} : { code: finalCode }),
    message,
    raw,
    title: `[${tag}] ${message}`,
    displayCategory,
    signature: signature(category, message),
  };
}

/**
 * The command as it leads a headline: its first non-blank line, without ANSI
 * escapes, cut to {@link COMMAND_MAX_CHARS}; `undefined` when there is none.
 */
function commandLine(command: string | undefined): string | undefined {
  const first = (command ?? "")
    .replace(ANSI, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  return first === undefined ? undefined : cap(first, COMMAND_MAX_CHARS);
}

/** The record for one input, or `undefined` when it is not an error at all. */
function recordFor(
  input: CaptureInput,
  options: CaptureOptions,
): CaptureRecord | undefined {
  switch (input.kind) {
    case "llm": {
      const code = input.code.trim().toUpperCase() || "UNKNOWN";
      // The code leads the message, as in the seed entries, so a provider that
      // words the same failure differently still shares the code fallback.
      return build("llm", "llm", `llm / ${code}`, input.message, code, code);
    }
    case "agent": {
      const { message, name, code } = safeErrorText(input.error);
      const full =
        name !== undefined && name !== "Error" && !message.startsWith(name)
          ? `${name}: ${message}`
          : message;
      return build("agent", "agent", "agent", full, code);
    }
    case "tool": {
      if (!input.isError) return undefined;
      const code = input.code?.trim() || undefined;
      return build(
        "tool",
        `tool:${input.toolName}`,
        `tool / ${input.toolName}`,
        input.message,
        code,
      );
    }
    case "command": {
      const n = exitCode(input.text);
      if (n === undefined || n === 0 || !options.captureExitCodes)
        return undefined;
      // The marker is the harness's, not the command's: leave it out of the
      // headline, or it would be the last line of every output.
      const body = input.text.replace(EXIT_MARKER, "");
      const text = body.trim() === "" ? `exit code ${n}` : body;
      const headline = extractHeadline(text);
      // A headline that names no code - `exit code 1`, `1 test failed` - says
      // nothing about which command failed, so the command leads it. Otherwise
      // two unrelated silent failures would share one signature: a false
      // merge, the worst outcome matching can have.
      const command = commandLine(input.command);
      const line =
        command !== undefined && headline.code === undefined
          ? { line: cap(`${command} → ${headline.line}`) }
          : headline;
      const record = build(
        "command-exit",
        `command-exit:${input.toolName}`,
        `command-exit / ${input.toolName}`,
        text,
        undefined,
        "",
        line,
      );
      return { ...record, raw: input.text, exitCode: n };
    }
  }
}

/**
 * Classify one captured error (§6).
 *
 * @param input - one of the four source shapes.
 * @param counter - this session's transient counter; bumped for transient
 *   LLM failures only.
 * @param options - settings; anything missing takes its default.
 * @returns the record and its decision, or `undefined` when nothing is
 *   captured: the source is off in `capture`, a tool result is not an error,
 *   a command exited 0 or reported no exit code, or `captureExitCodes` is off.
 */
export function classify(
  input: CaptureInput,
  counter: TransientCounter,
  options: Partial<CaptureOptions> = {},
): Classified | undefined {
  const o: CaptureOptions = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
  if (!o.capture.includes(input.kind)) return undefined;
  const record = recordFor(input, o);
  if (record === undefined) return undefined;

  const transient =
    input.kind === "llm" && TRANSIENT.has(record.code as string);
  if (!transient) return { decision: "record", record, transient };

  const count = counter.bump(record.signature);
  const promoted = count === effectiveTransientThreshold(o.transientThreshold);
  return {
    decision: promoted ? "record" : "count-only",
    record,
    transient,
    count,
    promoted,
  };
}
