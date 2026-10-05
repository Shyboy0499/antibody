// Ported from dsh-errkb, src/signature.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
// "Same error" as a number: normalization and the signature (§5.1-5.2).
//
// Everything here is a pure string function. `normalize` turns one raw error
// message into a stable form by stripping what changes from run to run - ANSI
// colour, timestamps, durations, PIDs, ports, line and column numbers, UUIDs,
// hashes, temp-directory names and absolute paths - while keeping what tells two
// errors apart: the words, the codes, and the last segment of every path.
// `signature` hashes that form together with the category.
//
// Deliberately not here (still open in docs/discussions.md §2): picking a
// headline line out of multi-line output, treating localized OS text as a near
// hit, and tokenizing CJK text for fuzzy matching. Those belong to the matcher.
import { createHash } from "node:crypto";

/** The placeholders normalization writes, one per class of run-to-run noise. */
export const PLACEHOLDER = {
  ts: "<ts>",
  pid: "<pid>",
  port: "<port>",
  pos: "<pos>",
  uuid: "<uuid>",
  hash: "<hash>",
  tmp: "<tmp>",
  path: "<path>",
} as const;

/** Length of a signature, in hex characters. */
export const SIGNATURE_LENGTH = 12;

// CSI sequences (colours, cursor movement) and OSC sequences (hyperlinks, window
// titles), which is what terminals and test runners actually emit. Matching the
// ESC and BEL control characters is the whole point of this expression.
// Exported so capture strips the same sequences before picking a headline.
export const ANSI =
  // oxlint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// One path segment: anything a message does not use to delimit a path. A
// placeholder written by an earlier step counts as a segment character too, so
// `/tmp/<tmp>/a.ts` is still one path.
const SEGMENT = String.raw`(?:<[a-z-]+>|[^\s'"\x60<>|:*?\\/()\[\]{},;])+`;

/**
 * Absolute paths, in four shapes: a Windows drive path (optionally behind the
 * `\\?\` long-path prefix), a UNC share, a `~` home path, and a POSIX path with
 * at least two segments. The POSIX form refuses to start right after a word
 * character, a dot, a colon or a slash, which keeps `https://host/a/b`,
 * `a/b/c` and an already-collapsed `<path>/x` out of it.
 *
 * Exported so redaction collapses exactly the same paths (§4.4 `share: 'public'`).
 */
export const ABSOLUTE_PATH = new RegExp(
  [
    String.raw`(?<![\w\\])(?:\\\\\?\\)?[A-Za-z]:[\\/]${SEGMENT}(?:[\\/]${SEGMENT})*[\\/]?`,
    String.raw`(?<![\w\\])\\\\${SEGMENT}(?:\\${SEGMENT})+\\?`,
    String.raw`(?<![\w.:/\\<>~-])~[\\/]${SEGMENT}(?:[\\/]${SEGMENT})*[\\/]?`,
    String.raw`(?<![\w.:/\\<>~-])\/${SEGMENT}(?:\/${SEGMENT})+\/?`,
  ].join("|"),
  "g",
);

// The parent directory of a per-user home. A path that ends at `<root>/<user>`
// keeps no last segment, because that segment is the user name.
const HOME_ROOTS = new Set(["users", "home"]);

/**
 * Collapse one absolute path to `<path>` plus its last segment, written with the
 * separator the path used: `<path>\package.json`, `<path>/tsconfig.json`.
 *
 * The last segment is kept because it is what tells `ENOENT ... package.json`
 * from `ENOENT ... tsconfig.json`. Two exceptions drop it: a path that is only a
 * directory (trailing separator), and a bare home directory such as
 * `C:/Users/<name>`, whose last segment is a user name. Sentence punctuation
 * that the segment class swallowed (a trailing `.`) is handed back outside the
 * placeholder.
 *
 * @param path - one match of {@link ABSOLUTE_PATH}.
 * @returns the collapsed form.
 */
export function collapsePath(path: string): string {
  const trailing = /\.+$/.exec(path)?.[0] ?? "";
  const body = path.slice(0, path.length - trailing.length);
  const segments = body
    .split(/[\\/]+/)
    .filter((segment) => segment !== "" && segment !== "?" && segment !== "~")
    .filter((segment) => !/^[A-Za-z]:$/.test(segment));
  if (/[\\/]$/.test(body)) return PLACEHOLDER.path + trailing;
  const [root = "", ...rest] = segments;
  if (rest.length === 1 && HOME_ROOTS.has(root.toLowerCase()))
    return PLACEHOLDER.path + trailing;
  const cut = Math.max(body.lastIndexOf("/"), body.lastIndexOf("\\"));
  return `${PLACEHOLDER.path}${body.slice(cut)}${trailing}`;
}

/**
 * Replace every absolute path in a text with its collapsed form.
 *
 * @param text - any text.
 * @returns the text with paths collapsed; idempotent.
 */
export function collapseAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, collapsePath);
}

// Step 2, in the order it runs. Order matters in three places: UUIDs and hashes
// go before timestamps so a date-shaped run inside a hash is never split, ports
// go before positions so `127.0.0.1:3000` is a port and not a line number, and
// temp-directory names go before path collapsing so a temp directory that is the
// last segment is still replaced.
const NOISE: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    PLACEHOLDER.uuid,
  ],
  // 64 hex characters is a SHA-256; anything from 32 up (MD5, SHA-1, content
  // hashes in store paths) is just as random from one run to the next.
  [/(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi, PLACEHOLDER.hash],
  [
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
    PLACEHOLDER.ts,
  ],
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, PLACEHOLDER.ts],
  // Durations: `123ms`, `1.5s`, `30 ms`, `耗时 123ms`, `123 毫秒`.
  [/\b\d+(?:\.\d+)?\s?(?:ms|s)\b|\d+(?:\.\d+)?\s?毫?秒/g, PLACEHOLDER.ts],
  [/\bpid\s*[:=#]?\s*\d+/gi, PLACEHOLDER.pid],
  [/\bport\s*[:=#]?\s*\d+/gi, PLACEHOLDER.port],
  [
    /(localhost|\b\d{1,3}(?:\.\d{1,3}){3}|\]|::):\d{1,5}\b/gi,
    `$1:${PLACEHOLDER.port}`,
  ],
  [/\bline\s+\d+(?:\s*[:,]\s*\d+)?/gi, PLACEHOLDER.pos],
  [/\bcol(?:umn)?\s+\d+/gi, PLACEHOLDER.pos],
  [/(\.[A-Za-z]\w*):\d+(?::\d+)?\b/g, `$1:${PLACEHOLDER.pos}`],
  [/:\d+:\d+\b/g, `:${PLACEHOLDER.pos}`],
  [/\(\d+,\s?\d+\)/g, `(${PLACEHOLDER.pos})`],
  // Temp directories: the segment right after a temp root, and the `tmp-…` /
  // `tmp_…` names that mkdtemp-style helpers create anywhere.
  [/([\\/](?:tmp|temp)[\\/])[^\\/\s'"`]+/gi, `$1${PLACEHOLDER.tmp}`],
  [/\btmp[-_][\w-]+/gi, PLACEHOLDER.tmp],
];

// Unicode punctuation and whitespace at either end. `<` and `>` are math
// symbols, not punctuation, so a trailing placeholder survives.
const EDGE_PUNCTUATION = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

/**
 * Normalize one raw error message (§5.1):
 *
 * 1. strip ANSI escapes and `\r`, collapse whitespace;
 * 2. replace timestamps, durations, PIDs, ports, line/column positions, UUIDs,
 *    hashes and temp-directory names with placeholders;
 * 3. collapse absolute paths to `<path>`, keeping the last segment;
 * 4. lowercase, and trim punctuation from both ends.
 *
 * @param raw - the message as captured; any string, including empty.
 * @returns the normalized form; idempotent.
 */
export function normalize(raw: string): string {
  let text = raw.replace(ANSI, "").replace(/\r/g, "").replace(/\s+/g, " ");
  for (const [pattern, replacement] of NOISE)
    text = text.replace(pattern, replacement);
  text = collapseAbsolutePaths(text);
  return text.toLowerCase().replace(EDGE_PUNCTUATION, "");
}

/**
 * The signature of an error (§5.2): the first twelve hex characters of
 * `sha256(category + "\u0000" + normalize(message))`.
 *
 * Only the message is hashed, never a stack: stack lines carry the most noise,
 * and `LlmFailure` only reports a normalized message plus a code anyway. The NUL
 * separator keeps `("a", "bc")` and `("ab", "c")` apart.
 *
 * @param category - the capture category, e.g. `tool` or `llm`.
 * @param message - the raw message.
 * @returns twelve lowercase hex characters.
 */
export function signature(category: string, message: string): string {
  return createHash("sha256")
    .update(`${category}\u0000${normalize(message)}`)
    .digest("hex")
    .slice(0, SIGNATURE_LENGTH);
}
