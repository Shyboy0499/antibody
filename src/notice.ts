// Ported from dsh-errkb, src/inject.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE): the notice text and the caps. Section marks such as §7 refer to
// dsh-errkb's design document.
//
// Notices: what an agent is told about a captured error, and how often.
//
// Wording:
//
//   hit       [antibody] E-0007 known (5 hits) | cause: … | fix: … Known fix: try
//             this first, before re-diagnosing or researching.
//   near hit  … | fix: … Approximate match, verify first.
//   doubted   … | fix: … This fix failed here last time; verify before applying.
//   no fix    [antibody] E-0007 seen before (5 hits), no fix recorded yet.
//   miss      [antibody] recorded as E-0011 (no fix yet).
//
// The hit wording orders the work ("try this first") instead of forbidding any
// ("do not re-diagnose"). A hit without a fix still speaks, briefly: the agent
// learns the error is a repeat and that its fix is worth recording.
//
// Caps (§7). The body is at most 400 characters and at most 120 tokens by
// estimateTokens(); cause and fix are clipped to fit, the fix last, so the
// closing instruction is never cut. CapTracker allows 1 notice per step, 3 per
// turn and 2 per ID per session, and a `fixed` entry 1 per session.
//
// dsh-errkb also attaches a DeepSeek Harness message source to each notice.
// antibody hands notices to each harness's hook as plain text, so that part
// stays behind.
import type { Hit } from "./match";

/** How every notice introduces itself to the agent. */
export const NOTICE_PREFIX = "[antibody]";

/** A notice body never exceeds this many characters (§7). */
export const NOTICE_MAX_CHARS = 400;

/** A notice body never exceeds this many tokens by estimateTokens() (§7). */
export const NOTICE_MAX_TOKENS = 120;

/** The cause is clipped to this many characters before anything else. */
export const CAUSE_MAX_CHARS = 100;

/** When a notice is too long, the cause gives way down to this, then the fix. */
export const CAUSE_MIN_CHARS = 40;

/** Marks clipped text. */
export const ELLIPSIS = "…";

/** Values of the `inject` setting. */
export const INJECT_MODES = ["hit-only", "always", "off"] as const;

/** `hit-only` keeps misses silent; `always` announces them; `off` says nothing. */
export type InjectMode = (typeof INJECT_MODES)[number];

/** The closing sentences, exactly as the model reads them. */
export const WORDING = {
  hit: "Known fix: try this first, before re-diagnosing or researching.",
  approximate: "Approximate match, verify first.",
  doubted: "This fix failed here last time; verify before applying.",
} as const;

/** How far a fix is trusted on this machine. */
export type TrustLevel = "trusted" | "doubted" | "suppressed";

/** What a notice says, which also names its wording. */
export type NoticeKind =
  | "hit"
  | "near"
  | "doubted"
  | "no-fix"
  | "miss"
  /** The one-shot request for the fix of an entry that looks resolved (T14). */
  | "ask-fix";

/** One notice, ready to inject. */
export interface Notice {
  id: string;
  kind: NoticeKind;
  /** The agent-facing body: one line, within both caps. */
  text: string;
}

/** What happened to a captured error, as the injector sees it. */
export type NoticeEvent =
  | { kind: "hit"; hit: Hit }
  /** No entry matched and the store recorded a new one under `id`. */
  | { kind: "miss"; id: string };

// ---------------------------------------------------------------------------
// Text

// Code points outside printable ASCII and its whitespace. Each counts as a
// whole token: CJK characters usually are one, and accented or symbol
// characters are at most one in practice. (Bodies are one line, so other
// ASCII control characters never reach this.)
const NON_ASCII = /[^ -~\t\n\r]/gu;

/** ASCII characters per token in estimateTokens(); English averages about 4. */
export const ASCII_CHARS_PER_TOKEN = 3;

/**
 * A conservative token estimate that needs no tokenizer: every non-ASCII code
 * point counts as one token, ASCII as one per {@link ASCII_CHARS_PER_TOKEN}
 * characters, rounded up. It overestimates English by about a quarter and
 * Chinese by a little more, so a notice inside the cap is inside it for real.
 *
 * @param text - any text.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  const wide = text.match(NON_ASCII)?.length ?? 0;
  const ascii = text.length - wide - surrogateUnits(text);
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + wide;
}

// A non-BMP code point is two UTF-16 units but one match above; take the
// second unit back out of the ASCII count.
function surrogateUnits(text: string): number {
  return text.length - Array.from(text).length;
}

/**
 * Whether a body is inside both caps.
 *
 * @param text - a notice body.
 */
export function withinCaps(text: string): boolean {
  return (
    Array.from(text).length <= NOTICE_MAX_CHARS &&
    estimateTokens(text) <= NOTICE_MAX_TOKENS
  );
}

/** Collapse runs of whitespace, newlines included, to one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Clip text to at most `max` code points, the last of them an ellipsis when
 * anything was cut.
 *
 * @param text - the text.
 * @param max - the limit in code points; 0 or less gives the empty string.
 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 0) return "";
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}${ELLIPSIS}`;
}

// The largest n in [low, high] for which ok(n) holds, assuming ok is
// monotone; undefined when ok(low) does not.
function largest(
  low: number,
  high: number,
  ok: (n: number) => boolean,
): number | undefined {
  if (!ok(low)) return undefined;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ok(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Fit a cause and a fix into a template within both caps. The cause is first
 * clipped to {@link CAUSE_MAX_CHARS}; if the result is still too long the cause
 * shrinks towards {@link CAUSE_MIN_CHARS}, and only then does the fix shrink.
 * Whatever the template adds stays whole. A template too long on its own (an
 * absurd ID) is clipped as a last resort.
 *
 * @param render - builds the body from a clipped cause and fix.
 * @param cause - the cause, one line.
 * @param fix - the fix, one line.
 * @returns a body inside both caps.
 */
export function fitNotice(
  render: (cause: string, fix: string) => string,
  cause: string,
  fix: string,
): string {
  const causeChars = Math.min(Array.from(cause).length, CAUSE_MAX_CHARS);
  const fixChars = Array.from(fix).length;
  const fits = (c: number, f: number) =>
    withinCaps(render(clip(cause, c), clip(fix, f)));

  if (fits(causeChars, fixChars)) return render(clip(cause, causeChars), fix);
  const floor = Math.min(causeChars, CAUSE_MIN_CHARS);
  const c = largest(floor, causeChars, (n) => fits(n, fixChars));
  if (c !== undefined) return render(clip(cause, c), fix);
  const f = largest(0, fixChars, (n) => fits(floor, n));
  if (f !== undefined) return render(clip(cause, floor), clip(fix, f));
  return hardClip(render(clip(cause, floor), ""));
}

/**
 * Clip a whole body until it is inside both caps.
 *
 * @param text - a notice body.
 * @returns the longest clip of it that fits.
 */
export function hardClip(text: string): string {
  const n = largest(0, Array.from(text).length, (m) =>
    withinCaps(clip(text, m)),
  ) as number;
  return clip(text, n);
}

const hitsText = (hits: number) => `${hits} ${hits === 1 ? "hit" : "hits"}`;

/**
 * The body of a notice. Pure; caps are applied here, counts are not.
 *
 * @param event - the hit or miss.
 * @param trust - the fix's trust level; ignored for a miss or an entry
 *   without a fix.
 * @returns the kind and the body.
 */
export function noticeText(
  event: NoticeEvent,
  trust: TrustLevel = "trusted",
): { kind: NoticeKind; text: string } {
  if (event.kind === "miss")
    return {
      kind: "miss",
      text: hardClip(`${NOTICE_PREFIX} recorded as ${event.id} (no fix yet).`),
    };

  const { hit } = event;
  const { id, entry } = hit;
  const fix = oneLine(entry.fix);
  const near = hit.approximate ? ", approximate match" : "";
  if (fix === "")
    return {
      kind: "no-fix",
      text: hardClip(
        `${NOTICE_PREFIX} ${id} seen before (${hitsText(entry.hits)}${near}), no fix recorded yet.`,
      ),
    };

  const doubted = trust !== "trusted";
  const closing: string[] = [
    ...(hit.approximate ? [WORDING.approximate] : []),
    ...(doubted ? [WORDING.doubted] : []),
  ];
  if (closing.length === 0) closing.push(WORDING.hit);
  const kind: NoticeKind = doubted
    ? "doubted"
    : hit.approximate
      ? "near"
      : "hit";

  const cause = oneLine(entry.trigger);
  const head = `${NOTICE_PREFIX} ${id} known (${hitsText(entry.hits)})`;
  const tail = closing.join(" ");
  const render = (c: string, f: string) =>
    `${head}${c === "" ? "" : ` | cause: ${c}`} | fix: ${f} ${tail}`;
  return { kind, text: fitNotice(render, cause, fix) };
}

// ---------------------------------------------------------------------------
// Caps

/** The notice budget (§7). Every limit can only be lowered. */
export interface CapLimits {
  perStep: number;
  perTurn: number;
  perIdPerSession: number;
  /** For an entry whose status is `fixed`. */
  fixedPerSession: number;
}

export const DEFAULT_CAP_LIMITS: CapLimits = {
  perStep: 1,
  perTurn: 3,
  perIdPerSession: 2,
  fixedPerSession: 1,
};

/**
 * Counts one session's notices. Create one per session; call beginTurn() and
 * beginStep() at those boundaries, and tryEmit() before each notice.
 */
export class CapTracker {
  readonly limits: CapLimits;
  private step = 0;
  private turn = 0;
  private readonly perId = new Map<string, number>();

  /** @param limits - lower limits; a value above the default is ignored. */
  constructor(limits: Partial<CapLimits> = {}) {
    const l = { ...DEFAULT_CAP_LIMITS };
    for (const key of Object.keys(l) as (keyof CapLimits)[])
      l[key] = Math.min(l[key], limits[key] ?? l[key]);
    this.limits = l;
  }

  /** A new turn: the turn and step budgets start again. */
  beginTurn(): void {
    this.turn = 0;
    this.step = 0;
  }

  /** A new step within the turn: the step budget starts again. */
  beginStep(): void {
    this.step = 0;
  }

  /**
   * Take one notice from every budget, if every budget has one left.
   *
   * @param id - the entry the notice is about.
   * @param fixed - whether the entry's status is `fixed`.
   * @returns whether the notice may be emitted; nothing is taken when not.
   */
  tryEmit(id: string, fixed = false): boolean {
    const used = this.perId.get(id) ?? 0;
    const perId = fixed
      ? this.limits.fixedPerSession
      : this.limits.perIdPerSession;
    if (
      this.step >= this.limits.perStep ||
      this.turn >= this.limits.perTurn ||
      used >= perId
    )
      return false;
    this.step++;
    this.turn++;
    this.perId.set(id, used + 1);
    return true;
  }
}
