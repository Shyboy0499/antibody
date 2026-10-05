// Ported from dsh-errkb, src/match.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
// "Have we seen this before?": match a captured error against the document's
// entries (§5.3).
//
// Four steps, first one that answers wins:
//
// 1. exact - the error's signature equals an entry's `sig=`;
// 2. fuzzy - Jaccard similarity of normalized token sets reaches
//    `fuzzyThreshold`, within the same category: a near hit;
// 3. code fallback - same category, same code, and both messages shorter than
//    40 characters after normalize() (`NO_ADAPTER` and friends): a near hit.
//    The entry side is its stored, already-redacted sample, so measuring both
//    normalized keeps a long path from counting on one side only;
// 4. otherwise a miss, and the store assigns a new ID.
//
// A near hit carries `approximate: true` so the injected notice can say
// "approximate match, verify first". An entry marked `wontfix`, or flagged
// `misjudged=true` in its machine comment, still matches - its counter keeps
// running - but the result says not to inject it (§5.3 误判兜底).
//
// Tokenization answers docs/discussions.md §2c: Latin and number runs are
// words, CJK runs become character bigrams, and placeholders such as `<path>`
// stay one token. Without the bigrams a Chinese message has no spaces, is one
// token, and its Jaccard is always 0 or 1.
//
// Everything here is pure: entries come in already parsed, nothing touches the
// disk. `indexEntries` does the per-entry work once so a long session can reuse
// it across many matches.
import { normalize, signature } from "./signature";
import type { Entry } from "./store";

/** A message at or above this many characters never takes the code fallback. */
export const SHORT_MESSAGE_CHARS = 40;

/** Matching settings; every one has a default. */
export interface MatchOptions {
  /** Minimum Jaccard similarity for a fuzzy near hit (the `fuzzyThreshold` setting). */
  fuzzyThreshold: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  fuzzyThreshold: 0.72,
};

/** What capture knows about an error. */
export interface CapturedError {
  /** The capture category, e.g. `tool` or `llm`, as passed to signature(). */
  category: string;
  /** A stable code such as `EPERM` or `NO_ADAPTER`, when there is one. */
  code?: string;
  /** The raw message. */
  message: string;
  /** The current project, to break ties in favour of its own entries (§17 Q5). */
  proj?: string;
}

/** One entry with everything matching needs, computed once. */
export interface IndexedEntry {
  entry: Entry;
  sig: string;
  category: string;
  code: string | undefined;
  proj: string | undefined;
  tokens: ReadonlySet<string>;
  /** Length of the normalized message, in characters. */
  length: number;
  /** Why the entry must not be injected, if it must not. */
  excluded: Exclusion | undefined;
}

/** Why a matched entry is not injected. */
export type Exclusion = "wontfix" | "misjudged";

/** Which step produced a match. */
export type MatchVia = "exact" | "fuzzy" | "code";

/** A match. */
export interface Hit {
  matched: true;
  id: string;
  entry: Entry;
  via: MatchVia;
  /** True for a near hit: inject it labelled "approximate match, verify first". */
  approximate: boolean;
  /** Jaccard similarity of the token sets; 1 for an exact hit. */
  similarity: number;
  /** False when the entry is `wontfix` or misjudged: count it, never inject it. */
  injectable: boolean;
  excluded?: Exclusion;
}

/** No entry matched; the caller records a new one. */
export interface Miss {
  matched: false;
}

export type MatchResult = Hit | Miss;

// Han (with its extensions and compatibility ideographs), kana and Hangul.
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;

// A placeholder written by normalize(), a CJK run, or a run of any other
// letters, digits and underscores. The word alternative refuses CJK characters,
// so `eperm拒绝访问` splits into a word and a CJK run.
const TOKEN = new RegExp(
  String.raw`<[a-z]+>|[${CJK}]+|(?:(?![${CJK}])[\p{L}\p{N}_])+`,
  "gu",
);
const CJK_RUN = new RegExp(String.raw`^[${CJK}]`, "u");

/**
 * Split a normalized message into its token set.
 *
 * Words and placeholders are tokens as they stand. A CJK run becomes its
 * character bigrams (`拒绝访问` → `拒绝`, `绝访`, `访问`), and a single CJK
 * character stays a unigram. Punctuation and whitespace only separate tokens.
 *
 * @param text - normalize() output; other text works but is not lowercased.
 * @returns the distinct tokens.
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const [run] of text.matchAll(TOKEN)) {
    if (!CJK_RUN.test(run)) {
      tokens.add(run);
      continue;
    }
    const chars = Array.from(run);
    if (chars.length === 1) tokens.add(run);
    for (let i = 0; i + 1 < chars.length; i++)
      tokens.add(`${chars[i]}${chars[i + 1]}`);
  }
  return tokens;
}

/**
 * Jaccard similarity: shared tokens over all tokens.
 *
 * @returns a number from 0 to 1; 0 when both sets are empty, since two empty
 *   messages give nothing to go on.
 */
export function jaccard(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The message an entry is compared by: its raw sample, or its title when the
 * sample is empty (a hand-written entry may have none).
 */
function entryMessage(entry: Entry): string {
  return entry.raw.trim() === "" ? entry.title : entry.raw;
}

/**
 * Prepare entries for matching. The category is the `cat=` machine field, or
 * the part of the display category before ` / ` when an entry lacks one.
 *
 * @param entries - parsed entries, e.g. from store.read().
 * @returns one indexed entry per input, in the same order.
 */
export function indexEntries(entries: readonly Entry[]): IndexedEntry[] {
  return entries.map((entry) => {
    const message = normalize(entryMessage(entry));
    const misjudged = entry.meta.misjudged?.toLowerCase() === "true";
    return {
      entry,
      sig: entry.meta.sig ?? entry.fingerprint,
      category:
        entry.meta.cat ?? (entry.category.split("/")[0] as string).trim(),
      code: entry.meta.code,
      proj: entry.meta.proj,
      tokens: tokenize(message),
      length: Array.from(message).length,
      excluded:
        entry.status === "wontfix"
          ? "wontfix"
          : misjudged
            ? "misjudged"
            : undefined,
    };
  });
}

const idNumber = (id: string) => Number(/\d+$/.exec(id)?.[0] ?? Infinity);

/**
 * Pick the best candidate: highest similarity, then the error's own project,
 * then the lowest ID (the oldest entry, which is the one people have edited).
 */
function best(
  candidates: Array<{ indexed: IndexedEntry; similarity: number }>,
  proj: string | undefined,
) {
  const sameProj = (c: { indexed: IndexedEntry }) =>
    proj !== undefined && c.indexed.proj === proj ? 1 : 0;
  return candidates.reduce<(typeof candidates)[number] | undefined>(
    (winner, c) => {
      if (winner === undefined) return c;
      if (c.similarity !== winner.similarity)
        return c.similarity > winner.similarity ? c : winner;
      if (sameProj(c) !== sameProj(winner))
        return sameProj(c) > sameProj(winner) ? c : winner;
      return idNumber(c.indexed.entry.id) < idNumber(winner.indexed.entry.id)
        ? c
        : winner;
    },
    undefined,
  );
}

function hit(
  winner: { indexed: IndexedEntry; similarity: number },
  via: MatchVia,
): Hit {
  const { entry, excluded } = winner.indexed;
  return {
    matched: true,
    id: entry.id,
    entry,
    via,
    approximate: via !== "exact",
    similarity: winner.similarity,
    injectable: excluded === undefined,
    ...(excluded === undefined ? {} : { excluded }),
  };
}

/**
 * Match one captured error against the knowledge base (§5.3).
 *
 * @param error - the captured error.
 * @param index - from indexEntries().
 * @param options - settings; anything missing takes its default.
 * @returns the best hit or near hit, or a miss.
 */
export function match(
  error: CapturedError,
  index: readonly IndexedEntry[],
  options: Partial<MatchOptions> = {},
): MatchResult {
  const o: MatchOptions = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const normalized = normalize(error.message);
  const tokens = tokenize(normalized);
  const score = (indexed: IndexedEntry) => ({
    indexed,
    similarity: jaccard(tokens, indexed.tokens),
  });

  const sig = signature(error.category, error.message);
  const exact = best(
    index
      .filter((indexed) => indexed.sig === sig)
      .map((indexed) => ({ indexed, similarity: 1 })),
    error.proj,
  );
  if (exact !== undefined) return hit(exact, "exact");

  const sameCategory = index.filter((i) => i.category === error.category);
  const fuzzy = best(
    sameCategory.map(score).filter((c) => c.similarity >= o.fuzzyThreshold),
    error.proj,
  );
  if (fuzzy !== undefined) return hit(fuzzy, "fuzzy");

  const short = Array.from(normalized).length < SHORT_MESSAGE_CHARS;
  const code = error.code;
  const sameCode = best(
    sameCategory
      .filter(
        (i) =>
          short &&
          code !== undefined &&
          code !== "" &&
          i.code === code &&
          i.length < SHORT_MESSAGE_CHARS,
      )
      .map(score),
    error.proj,
  );
  if (sameCode !== undefined) return hit(sameCode, "code");

  return { matched: false };
}
