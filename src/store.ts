// Ported from dsh-errkb, src/store.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
// The error document: parse, render, append, update and archive `ANTIBODIES.md`
// (§8), safely under concurrent writers (§13).
//
// The format is parsed into entries, but every block also keeps its exact
// source text. Rendering a document concatenates those sources, so a document
// read and written back is byte-identical, and an update rewrites only the one
// block it changes. That is what makes hand edits safe: a fix typed into any
// Markdown editor survives every later write, because nothing outside the
// edited entry is ever re-rendered.
//
// Labels are presentation (§17 Q2): new blocks are written in English by
// default, or Chinese with `labels: 'zh'`, and the parser reads both sets
// whatever the setting. Machine fields live in the `<!-- antibody: ... -->`
// comment and never change language.
//
// Like paths.ts, the logic takes its machine as an argument: `StoreFs` and
// `StoreClock` are injected, so locking, staleness and corruption handling are
// testable without racing a real disk. `nodeStoreFs()` and `systemClock()` are
// the only parts that touch the machine.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { corruptFileName } from "./paths";
import type { KbFiles } from "./paths";
import { redact, redactSample } from "./redact";
import type { Share } from "./redact";

/** Entry status values (§8). */
export const ENTRY_STATUSES = ["open", "fixed", "wontfix"] as const;

/** One entry's status. */
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** Which label set new blocks are written in (the `labels` setting). */
export type LabelSet = "en" | "zh";

/** The human-readable field labels, in both languages (§8, §17 Q2). */
export const LABELS = {
  en: {
    fingerprint: "Fingerprint",
    category: "Category",
    firstSeen: "First seen",
    lastSeen: "Last seen",
    hits: "Hits",
    trigger: "Trigger",
    raw: "Raw message",
    fix: "Fix",
    status: "Status",
    notes: "Notes",
  },
  zh: {
    fingerprint: "指纹",
    category: "分类",
    firstSeen: "首次",
    lastSeen: "最近",
    hits: "命中",
    trigger: "触发",
    raw: "原始信息",
    fix: "解法",
    status: "状态",
    notes: "备注",
  },
} as const;

type LabelKey = keyof (typeof LABELS)["en"];

// Fields that open a line. Last seen and hits share the first-seen line.
type FieldKey = Exclude<LabelKey, "lastSeen" | "hits">;

const FIELD_BY_LABEL = new Map<string, FieldKey>();
for (const set of Object.values(LABELS))
  for (const key of [
    "fingerprint",
    "category",
    "firstSeen",
    "trigger",
    "raw",
    "fix",
    "status",
    "notes",
  ] as const)
    FIELD_BY_LABEL.set(set[key], key);

/** One parsed entry. */
export interface Entry {
  /** `E-0007`; never changed once written. */
  id: string;
  /** Header text after the ` · `. */
  title: string;
  /** Machine fields from the `<!-- antibody: ... -->` comment, in order. */
  meta: Record<string, string>;
  fingerprint: string;
  category: string;
  firstSeen: string;
  lastSeen: string;
  hits: number;
  trigger: string;
  /** The redacted raw sample, without its code fence. */
  raw: string;
  fix: string;
  status: EntryStatus;
  notes: string;
}

/** An entry together with its exact source text. */
export interface Block {
  entry: Entry;
  source: string;
}

/** A parsed `ANTIBODIES.md`: everything before the first entry, then the entries. */
export interface ErrorDocument {
  preamble: string;
  blocks: Block[];
}

/** A document that cannot be parsed. `line` is 1-based. */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`ANTIBODIES.md line ${line}: ${message}`);
    this.name = "ParseError";
  }
}

/** Header of a new document, and of a new archive. */
export const DOCUMENT_HEADER = "# ANTIBODIES\n";
export const ARCHIVE_HEADER = "# ANTIBODIES archive\n";

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const headerPattern = (idPrefix: string) =>
  new RegExp(`^## (${escapeRegExp(idPrefix)}\\d+) ·(?: (.*))?$`);

const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)|^={7}$/;
// The prefix antibody writes, and the one dsh-errkb wrote. Both parse, so an
// existing dsh-errkb document reads as it is; a block is only re-rendered, and
// so only switches prefix, when its entry is updated.
export const META_PREFIX = "antibody";
const META_LINE = /^<!-- (?:antibody|errkb):(.*)-->\s*$/;
const FIELD_LINE = /^- ([^:：]+)[:：] ?(.*)$/;

/**
 * Encode a machine-field value: `%`, whitespace and `>` are percent-encoded so a
 * value can never end the comment or split into two fields.
 */
export function encodeMetaValue(value: string): string {
  return value.replace(/[%\s>]/g, (ch) => encodeURIComponent(ch));
}

/** Inverse of {@link encodeMetaValue}; a malformed escape is kept literally. */
export function decodeMetaValue(value: string): string {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Format an entry ID: prefix plus zero-padded number.
 *
 * @param n - the ID number, from 1.
 * @param idPrefix - the `idPrefix` setting.
 * @param idWidth - the `idWidth` setting.
 * @returns e.g. `E-0007`.
 */
export function formatId(n: number, idPrefix = "E-", idWidth = 4): string {
  return `${idPrefix}${String(n).padStart(idWidth, "0")}`;
}

/**
 * Every ID number in a text's entry headers, found leniently - this is what
 * still works on a document that does not parse, and on the archive.
 *
 * @param text - a document or archive.
 * @param idPrefix - the `idPrefix` setting.
 * @returns the numbers, in document order.
 */
export function scanIdNumbers(text: string, idPrefix = "E-"): number[] {
  const pattern = new RegExp(`^## ${escapeRegExp(idPrefix)}(\\d+) ·`, "gm");
  return Array.from(text.matchAll(pattern), (m) => Number(m[1]));
}

/**
 * The next ID number: one more than the highest anywhere, so IDs only ever
 * increase and an archived ID is never reused (§4.3, §8).
 *
 * @param texts - the document and the archive.
 * @returns the next number, at least 1.
 */
export function nextIdNumber(texts: string[], idPrefix = "E-"): number {
  let max = 0;
  for (const text of texts)
    for (const n of scanIdNumbers(text, idPrefix)) max = Math.max(max, n);
  return max + 1;
}

const unwrapCode = (value: string) => /^`([^`]*)`$/.exec(value)?.[1] ?? value;
const wrapCode = (value: string) =>
  value === "" ? "" : value.includes("`") ? value : `\`${value}\``;

function dedent(line: string): string {
  if (line.startsWith("  ")) return line.slice(2);
  if (line.startsWith("\t")) return line.slice(1);
  return line;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] as string).trim() === "") start++;
  while (end > start && (lines[end - 1] as string).trim() === "") end--;
  return lines.slice(start, end);
}

function parseMeta(content: string, line: number): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const pair of content.trim().split(/\s+/).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0)
      throw new ParseError(`malformed machine field "${pair}"`, line);
    meta[pair.slice(0, eq)] = decodeMetaValue(pair.slice(eq + 1));
  }
  return meta;
}

function parseRaw(lines: string[], line: number): string {
  const open = /^(`{3,})/.exec(lines[0] ?? "");
  if (open === null) return lines.join("\n");
  const fence = open[1] as string;
  const close = lines.findIndex(
    (text, i) => i > 0 && new RegExp(`^${fence}\`*\\s*$`).test(text),
  );
  if (close === -1) throw new ParseError("unterminated code fence", line);
  return lines.slice(1, close).join("\n");
}

function parseSeen(
  value: string,
  line: number,
): Pick<Entry, "firstSeen" | "lastSeen" | "hits"> {
  const last = `(?:${LABELS.en.lastSeen}|${LABELS.zh.lastSeen})`;
  const hits = `(?:${LABELS.en.hits}|${LABELS.zh.hits})`;
  const match = new RegExp(
    `^(.*?)\\s*·\\s*${last}[:：]\\s*(.*?)\\s*·\\s*${hits}[:：]\\s*(\\S*)$`,
  ).exec(value);
  if (match === null)
    throw new ParseError("malformed first-seen / last-seen / hits line", line);
  if (!/^\d+$/.test(match[3] as string))
    throw new ParseError(`hit count "${match[3]}" is not a number`, line);
  return {
    firstSeen: match[1] as string,
    lastSeen: match[2] as string,
    hits: Number(match[3]),
  };
}

/**
 * Parse one block: a header line, the machine comment, and the labelled fields.
 * A field runs until the next line that opens a known field (§8), so a fix may
 * hold blank lines, bullets and code. Missing fields read as empty, a missing
 * status as `open`.
 */
function parseBlock(source: string, firstLine: number, header: RegExp): Entry {
  const lines = source.split("\n").map((line) => line.replace(/\r$/, ""));
  const head = header.exec(lines[0] as string) as RegExpExecArray;
  let meta: Record<string, string> | undefined;
  const fields = new Map<FieldKey, { lines: string[]; line: number }>();
  let current: string[] | undefined;
  for (let i = 1; i < lines.length; i++) {
    const text = lines[i] as string;
    const lineNo = firstLine + i;
    const metaMatch = META_LINE.exec(text);
    if (metaMatch !== null) {
      if (meta !== undefined)
        throw new ParseError("second machine-field comment", lineNo);
      meta = parseMeta(metaMatch[1] as string, lineNo);
      current = undefined;
      continue;
    }
    const field = FIELD_LINE.exec(text);
    const key = field && FIELD_BY_LABEL.get((field[1] as string).trim());
    if (field && key) {
      if (fields.has(key))
        throw new ParseError(`field "${field[1]}" appears twice`, lineNo);
      current = [field[2] as string];
      fields.set(key, { lines: current, line: lineNo });
      continue;
    }
    current?.push(dedent(text));
  }
  if (meta === undefined)
    throw new ParseError(
      "entry has no <!-- antibody: ... --> comment",
      firstLine,
    );

  const fieldText = (key: FieldKey) =>
    trimBlankLines(fields.get(key)?.lines ?? []).join("\n");
  const seenField = fields.get("firstSeen");
  const seen = seenField
    ? parseSeen(fieldText("firstSeen"), seenField.line)
    : { firstSeen: "", lastSeen: "", hits: 0 };
  const rawField = fields.get("raw");
  const raw = rawField
    ? parseRaw(trimBlankLines(rawField.lines), rawField.line)
    : "";
  const statusText =
    unwrapCode(fieldText("status")).trim().toLowerCase() || "open";
  if (!(ENTRY_STATUSES as readonly string[]).includes(statusText))
    throw new ParseError(
      `unknown status "${statusText}"`,
      (fields.get("status") as { line: number }).line,
    );

  return {
    id: head[1] as string,
    title: (head[2] ?? "").trim(),
    meta,
    fingerprint: unwrapCode(fieldText("fingerprint")),
    category: unwrapCode(fieldText("category")),
    ...seen,
    trigger: fieldText("trigger"),
    raw,
    fix: fieldText("fix"),
    status: statusText as EntryStatus,
    notes: fieldText("notes"),
  };
}

/**
 * Parse a whole document (§8): blocks split on `^## <prefix><digits> ·`.
 *
 * Parsing is strict about what would make a write unsafe - a git conflict
 * marker, a malformed entry header, a missing machine comment, a duplicate ID,
 * an unknown status, a broken first-seen line, an unterminated fence - and
 * lenient about everything a human might reasonably type: either label set,
 * either colon, a fix on the label's own line or below it, missing fields.
 *
 * @param text - the document; empty is a valid, empty document.
 * @param idPrefix - the `idPrefix` setting.
 * @returns the preamble and the blocks, each with its exact source.
 * @throws ParseError when the document is not safe to rewrite.
 */
export function parseDocument(text: string, idPrefix = "E-"): ErrorDocument {
  const header = headerPattern(idPrefix);
  const headerStart = `## ${idPrefix}`;
  const lines = text.split("\n");
  const starts: Array<{ offset: number; line: number }> = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, "");
    if (CONFLICT_MARKER.test(line))
      throw new ParseError("git conflict marker", i + 1);
    const looksLikeHeader =
      line.startsWith(headerStart) &&
      /\d/.test(line.charAt(headerStart.length));
    if (looksLikeHeader) {
      if (!header.test(line))
        throw new ParseError(`malformed entry header "${line}"`, i + 1);
      starts.push({ offset, line: i + 1 });
    }
    offset += (lines[i] as string).length + 1;
  }

  const blocks: Block[] = [];
  const seen = new Set<string>();
  for (let b = 0; b < starts.length; b++) {
    const start = starts[b] as { offset: number; line: number };
    const source = text.slice(start.offset, starts[b + 1]?.offset);
    const entry = parseBlock(source, start.line, header);
    if (seen.has(entry.id))
      throw new ParseError(`duplicate ID ${entry.id}`, start.line);
    seen.add(entry.id);
    blocks.push({ entry, source });
  }
  return {
    preamble: text.slice(0, starts[0]?.offset ?? text.length),
    blocks,
  };
}

/**
 * Render a document: the preamble, then every block's source. For a parsed
 * document this is the exact input text.
 */
export function renderDocument(document: ErrorDocument): string {
  return document.preamble + document.blocks.map((b) => b.source).join("");
}

function renderTextBlock(label: string, value: string): string[] {
  if (value === "") return [`- ${label}:`];
  return [
    `- ${label}:`,
    ...value.split("\n").map((line) => (line === "" ? "" : `  ${line}`)),
  ];
}

function renderInline(label: string, value: string): string[] {
  if (value.includes("\n")) return renderTextBlock(label, value);
  return [value === "" ? `- ${label}:` : `- ${label}: ${value}`];
}

/**
 * Render one entry as a block (§8), ending in a newline. The raw sample's fence
 * is longer than any backtick run inside it, so a sample can never close it.
 *
 * @param entry - the entry.
 * @param labels - which label set to write.
 * @returns the block text.
 */
export function renderEntry(entry: Entry, labels: LabelSet = "en"): string {
  const l = LABELS[labels];
  const runs = entry.raw.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  const meta = Object.entries(entry.meta)
    .map(([key, value]) => `${key}=${encodeMetaValue(value)}`)
    .join(" ");
  const raw = entry.raw
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`));
  return [
    `## ${entry.id} · ${entry.title}`,
    `<!-- ${META_PREFIX}: ${meta} -->`,
    "",
    ...renderInline(l.fingerprint, wrapCode(entry.fingerprint)),
    ...renderInline(l.category, wrapCode(entry.category)),
    `- ${l.firstSeen}: ${entry.firstSeen} · ${l.lastSeen}: ${entry.lastSeen} · ${l.hits}: ${entry.hits}`,
    ...renderInline(l.trigger, entry.trigger),
    `- ${l.raw}:`,
    `  ${fence}text`,
    ...raw,
    `  ${fence}`,
    ...renderTextBlock(l.fix, entry.fix),
    `- ${l.status}: \`${entry.status}\``,
    ...renderTextBlock(l.notes, entry.notes),
    "",
  ].join("\n");
}

/**
 * Which label set a block was written in, so an update rewrites it in the same
 * language instead of switching one entry over.
 */
export function detectLabels(source: string): LabelSet | undefined {
  for (const line of source.split("\n")) {
    const field = FIELD_LINE.exec(line.replace(/\r$/, ""));
    if (field === null) continue;
    const label = (field[1] as string).trim();
    if (Object.values(LABELS.zh).includes(label as never)) return "zh";
    if (Object.values(LABELS.en).includes(label as never)) return "en";
  }
  return undefined;
}

/** The separator that puts one blank line between `text` and what follows. */
function separatorAfter(text: string): string {
  if (text === "" || text.endsWith("\n\n")) return "";
  return text.endsWith("\n") ? "\n" : "\n\n";
}

/** Display form of a timestamp in an entry: `2026-09-14 09:12` (UTC). */
export function formatSeen(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/** Machine-field form of a timestamp: `2026-09-14T09:12:33Z`. */
export function formatFirst(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// The store: locking, atomic writes, corruption handling.

/** The filesystem operations the store needs, injected for testability. */
export interface StoreFs {
  /** File contents, or undefined when the file does not exist. */
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Create a file only if it does not exist (`wx`); false when it does. */
  createExclusive(path: string, data: string): Promise<boolean>;
  /** Modification time in ms, or undefined when the file does not exist. */
  mtimeMs(path: string): Promise<number | undefined>;
  /** Remove a file; a missing file is not an error. */
  remove(path: string): Promise<void>;
  /** Names in a directory; a missing directory lists as empty. */
  list(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
}

/** Time and randomness, injected for testability. */
export interface StoreClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  random(): number;
}

/** Store settings; every one has a default. */
export interface StoreOptions {
  idPrefix: string;
  idWidth: number;
  /** Above this many entries the oldest move to the archive. */
  maxEntries: number;
  labels: LabelSet;
  share: Share;
  maxSampleChars: number;
  /** A lock older than this is abandoned and may be taken over (§13: 10 s). */
  lockStaleMs: number;
  /** Give up waiting for the lock after this long. */
  lockTimeoutMs: number;
  /** Base delay between lock attempts; jittered by ±50%. */
  lockRetryMs: number;
}

export const DEFAULT_STORE_OPTIONS: StoreOptions = {
  idPrefix: "E-",
  idWidth: 4,
  maxEntries: 200,
  labels: "en",
  share: "public",
  maxSampleChars: 500,
  lockStaleMs: 10_000,
  lockTimeoutMs: 10_000,
  lockRetryMs: 10,
};

/** What a caller knows about a new error. Every text is redacted on the way in. */
export interface NewEntry {
  title: string;
  /** From signature(); stored as the fingerprint and as `sig=`. */
  signature: string;
  /** Display category, e.g. `tool / pwsh`. */
  category: string;
  /** Further machine fields, e.g. `{ cat: "tool", code: "EPERM" }`. */
  meta?: Record<string, string>;
  trigger?: string;
  raw?: string;
  fix?: string;
  status?: EntryStatus;
  notes?: string;
}

/** The fields an update may change. */
export interface EntryPatch {
  fix?: string;
  status?: EntryStatus;
  notes?: string;
  trigger?: string;
  lastSeen?: string;
  hits?: number;
}

/** Outcome of {@link ErrorStore.append}. */
export interface AppendResult {
  id: string;
  /** IDs moved to the archive by this append. */
  archived: string[];
  /** True when the document did not parse and the entry was only appended. */
  corrupt: boolean;
  /** File name of the saved-aside copy, when this append made one. */
  savedAs?: string;
}

/** The lock could not be taken in time. */
export class LockTimeoutError extends Error {
  constructor(readonly path: string) {
    super(`timed out waiting for the lock ${path}`);
    this.name = "LockTimeoutError";
  }
}

/** An update was refused because the document does not parse. */
export class StoreCorruptError extends Error {
  constructor(
    readonly parseError: ParseError,
    readonly savedAs: string | undefined,
  ) {
    super(
      `refusing to rewrite a document that does not parse: ${parseError.message}`,
    );
    this.name = "StoreCorruptError";
  }
}

// ---------------------------------------------------------------------------
// The lock and the atomic write, shared with state.ts.

/** How the `.lock` is taken: the store's three lock settings. */
export type LockOptions = Pick<
  StoreOptions,
  "lockStaleMs" | "lockTimeoutMs" | "lockRetryMs"
>;

// A name part no other writer on this machine is using right now: the process
// id, a per-process counter and some randomness. Lock tokens and temporary file
// names only need that; they used node:crypto's randomBytes in dsh-errkb, which
// costs a hook about 10 ms of start-up time on every write.
let uniqueCounter = 0;
function uniqueSuffix(): string {
  uniqueCounter++;
  return `${process.pid}-${uniqueCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Run `fn` holding the knowledge base's `.lock` (§13): created with `wx`, one
 * older than `lockStaleMs` is taken over, and waiting gives up after
 * `lockTimeoutMs` with a LockTimeoutError. The store and state.json take the
 * same lock, so one process never writes either while another is mid-write.
 *
 * @param lock - the `.lock` path; its directory is created first.
 */
export async function withFileLock<T>(
  lock: string,
  o: LockOptions,
  fs: StoreFs,
  clock: StoreClock,
  fn: () => Promise<T>,
): Promise<T> {
  // Take over the stale lock whose token was `held`, and nothing else. Two
  // waiters can judge the same lock stale; the first removes it and creates its
  // own, and without this re-check the second would then remove that fresh
  // lock and both would hold "the lock". Tokens are unique per acquisition, so
  // an unchanged token means the file is still the one judged stale. What is
  // left is the gap between this read and the remove: another waiter would
  // have to remove and re-create the lock inside it. That is two filesystem
  // calls racing one, not a judgment that can be seconds old, and closing it
  // fully would need an atomic compare-and-delete the filesystem does not
  // offer.
  async function removeIfUnchanged(held: string | undefined): Promise<void> {
    if ((await fs.readFile(lock)) === held) await fs.remove(lock);
  }

  await fs.mkdir(dirname(lock));
  const token = uniqueSuffix();
  const deadline = clock.now().getTime() + o.lockTimeoutMs;
  for (;;) {
    if (await fs.createExclusive(lock, token)) break;
    const held = await fs.readFile(lock);
    const mtime = await fs.mtimeMs(lock);
    const now = clock.now().getTime();
    if (mtime !== undefined && now - mtime > o.lockStaleMs) {
      await removeIfUnchanged(held);
      continue;
    }
    if (now >= deadline) throw new LockTimeoutError(lock);
    await clock.sleep(o.lockRetryMs * (0.5 + clock.random()));
  }
  try {
    return await fn();
  } finally {
    // Only release our own lock: if this write outlived lockStaleMs and
    // someone took over, the lock on disk is theirs now.
    if ((await fs.readFile(lock)) === token) await fs.remove(lock);
  }
}

/** Write `data` to a temp file beside `path`, then rename it over `path`. */
export async function writeFileAtomic(
  fs: StoreFs,
  path: string,
  data: string,
): Promise<void> {
  const temp = `${path}.${uniqueSuffix()}.tmp`;
  await fs.writeFile(temp, data);
  try {
    await fs.rename(temp, path);
  } catch (error) {
    await fs.remove(temp);
    throw error;
  }
}

/** The document store bound to one knowledge base directory. */
export interface ErrorStore {
  /** Parse the current document; a missing file is an empty document. */
  read(): Promise<ErrorDocument>;
  /** Record a new entry under the next ID. */
  append(input: NewEntry): Promise<AppendResult>;
  /** Change fields of an existing entry; undefined when the ID is unknown. */
  update(id: string, patch: EntryPatch): Promise<Entry | undefined>;
  /**
   * Move one entry to the archive (`antibody_forget`, T15), with `reason` added to
   * its notes; undefined when the ID is unknown. Nothing is deleted.
   */
  archive(id: string, reason?: string): Promise<Entry | undefined>;
}

const CORRUPT_COPY = /^ANTIBODIES\.corrupt-.*\.md$/;

/**
 * Bind a store to a knowledge base directory.
 *
 * Every write takes `.lock` (created with `wx`; one older than `lockStaleMs`
 * is taken over), reads the current files, and writes `ANTIBODIES.md` to a temp
 * file that is then renamed over the original. A document that does not parse
 * is saved aside as `ANTIBODIES.corrupt-<ts>.md` once, after which new entries are
 * only appended to it and updates are refused - it is never rewritten (§13).
 *
 * Archiving appends the oldest blocks to `ANTIBODIES.archive.md` before the
 * shortened document replaces the old one, so a crash in between duplicates an
 * entry across the two files rather than losing it.
 *
 * @param files - paths from resolveKbDir().
 * @param options - settings; anything missing takes its default.
 * @param fs - filesystem; defaults to the real one.
 * @param clock - time; defaults to the real one.
 */
export function createStore(
  files: Pick<KbFiles, "errors" | "archive" | "lock">,
  options: Partial<StoreOptions> = {},
  fs: StoreFs = nodeStoreFs(),
  clock: StoreClock = systemClock(),
): ErrorStore {
  const o: StoreOptions = { ...DEFAULT_STORE_OPTIONS, ...options };
  const dir = dirname(files.errors);
  const clean = (text: string) => redact(text.replace(/\r/g, ""), o).trim();
  const withLock = <T>(fn: () => Promise<T>) =>
    withFileLock(files.lock, o, fs, clock, fn);
  const writeAtomic = (path: string, data: string) =>
    writeFileAtomic(fs, path, data);

  async function saveAside(text: string): Promise<string | undefined> {
    for (const name of await fs.list(dir)) {
      if (!CORRUPT_COPY.test(name)) continue;
      const copy = await fs.readFile(join(dir, name));
      if (copy !== undefined && copy !== "" && text.startsWith(copy)) return;
    }
    const name = corruptFileName(clock.now());
    await fs.writeFile(join(dir, name), text);
    return name;
  }

  function build(id: string, input: NewEntry): Entry {
    const now = clock.now();
    const meta: Record<string, string> = { sig: input.signature };
    for (const [key, value] of Object.entries(input.meta ?? {}))
      meta[key] = clean(value);
    meta.first ??= formatFirst(now);
    return {
      id,
      title: clean(input.title).replace(/\s+/g, " "),
      meta,
      fingerprint: input.signature,
      category: clean(input.category),
      firstSeen: formatSeen(now),
      lastSeen: formatSeen(now),
      hits: 1,
      trigger: clean(input.trigger ?? ""),
      raw: redactSample((input.raw ?? "").replace(/\r/g, ""), o).replace(
        /^\n+|\n+$/g,
        "",
      ),
      fix: clean(input.fix ?? ""),
      status: input.status ?? "open",
      notes: clean(input.notes ?? ""),
    };
  }

  /** The current document, for a rewrite; one that does not parse is refused. */
  async function readForRewrite(): Promise<ErrorDocument> {
    const text = (await fs.readFile(files.errors)) ?? "";
    try {
      return parseDocument(text, o.idPrefix);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      throw new StoreCorruptError(error, await saveAside(text));
    }
  }

  /** Re-render one block in its own label set, keeping its trailing blank lines. */
  function rewrite(block: Block, entry: Entry): void {
    const trailing = (/\n*$/.exec(block.source) as RegExpExecArray)[0];
    const labels = detectLabels(block.source) ?? o.labels;
    block.entry = entry;
    block.source = renderEntry(entry, labels).replace(
      /\n$/,
      trailing.length > 0 ? trailing : "\n",
    );
  }

  return {
    async read() {
      return parseDocument((await fs.readFile(files.errors)) ?? "", o.idPrefix);
    },

    append(input) {
      return withLock(async () => {
        const text = (await fs.readFile(files.errors)) ?? "";
        const archiveText = (await fs.readFile(files.archive)) ?? "";
        const id = formatId(
          nextIdNumber([text, archiveText], o.idPrefix),
          o.idPrefix,
          o.idWidth,
        );
        const block = renderEntry(build(id, input), o.labels);

        try {
          parseDocument(text, o.idPrefix);
        } catch (error) {
          if (!(error instanceof ParseError)) throw error;
          const savedAs = await saveAside(text);
          await fs.appendFile(files.errors, separatorAfter(text) + block);
          return { id, archived: [], corrupt: true, savedAs };
        }

        const base = text === "" ? DOCUMENT_HEADER : text;
        const next = parseDocument(
          base + separatorAfter(base) + block,
          o.idPrefix,
        );
        const excess = next.blocks.length - o.maxEntries;
        const moved = excess > 0 ? next.blocks.splice(0, excess) : [];
        if (moved.length > 0) {
          // A new archive starts with its header; either way one blank line
          // separates what is there from what is appended.
          const header = archiveText === "" ? ARCHIVE_HEADER : "";
          const lead = header + separatorAfter(archiveText || ARCHIVE_HEADER);
          const body = moved.map((b) => b.source).join("");
          await fs.appendFile(files.archive, lead + body.replace(/\n*$/, "\n"));
        }
        await writeAtomic(files.errors, renderDocument(next));
        return { id, archived: moved.map((b) => b.entry.id), corrupt: false };
      });
    },

    update(id, patch) {
      return withLock(async () => {
        const document = await readForRewrite();
        const block = document.blocks.find((b) => b.entry.id === id);
        if (block === undefined) return undefined;

        const entry: Entry = { ...block.entry };
        if (patch.fix !== undefined) entry.fix = clean(patch.fix);
        if (patch.notes !== undefined) entry.notes = clean(patch.notes);
        if (patch.trigger !== undefined) entry.trigger = clean(patch.trigger);
        if (patch.lastSeen !== undefined)
          entry.lastSeen = clean(patch.lastSeen);
        if (patch.status !== undefined) entry.status = patch.status;
        if (patch.hits !== undefined) entry.hits = patch.hits;

        rewrite(block, entry);
        await writeAtomic(files.errors, renderDocument(document));
        return entry;
      });
    },

    archive(id, reason) {
      return withLock(async () => {
        const document = await readForRewrite();
        const index = document.blocks.findIndex((b) => b.entry.id === id);
        if (index === -1) return undefined;
        const block = document.blocks[index] as Block;

        const why = clean(reason ?? "").replace(/\s+/g, " ");
        const line = `Archived ${formatSeen(clock.now())}${why === "" ? "" : `: ${why}`}`;
        const notes =
          block.entry.notes === "" ? line : `${block.entry.notes}\n${line}`;
        const entry: Entry = { ...block.entry, notes };
        rewrite(block, entry);

        // Same order as maxEntries archiving: the archive gains the block
        // before the document loses it, so a crash in between duplicates the
        // entry rather than losing it.
        const archiveText = (await fs.readFile(files.archive)) ?? "";
        const header = archiveText === "" ? ARCHIVE_HEADER : "";
        const lead = header + separatorAfter(archiveText || ARCHIVE_HEADER);
        await fs.appendFile(
          files.archive,
          lead + block.source.replace(/\n*$/, "\n"),
        );
        document.blocks.splice(index, 1);
        await writeAtomic(files.errors, renderDocument(document));
        return entry;
      });
    },
  };
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * The real filesystem. Every "missing" case (ENOENT) is a value, not an error;
 * anything else - a directory where a file should be, a permission denial -
 * propagates.
 *
 * The calls are synchronous behind the async interface. node:fs/promises
 * loads the streams stack, which costs every hook about 10 ms before it does
 * anything, and a hook does one thing at a time anyway. The writes keep their
 * guarantees: `wx` still creates exclusively and appends still use O_APPEND.
 */
export function nodeStoreFs(): StoreFs {
  return {
    async readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeFile(path, data) {
      writeFileSync(path, data, "utf8");
    },
    async appendFile(path, data) {
      appendFileSync(path, data, "utf8");
    },
    async rename(from, to) {
      renameSync(from, to);
    },
    async createExclusive(path, data) {
      try {
        writeFileSync(path, data, { encoding: "utf8", flag: "wx" });
        return true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      }
    },
    async mtimeMs(path) {
      try {
        return statSync(path).mtimeMs;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
    },
    async remove(path) {
      rmSync(path, { force: true });
    },
    async list(dir) {
      try {
        return readdirSync(dir);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
    },
    async mkdir(dir) {
      mkdirSync(dir, { recursive: true });
    },
  };
}

/** The real clock. */
export function systemClock(): StoreClock {
  return {
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    random: Math.random,
  };
}
