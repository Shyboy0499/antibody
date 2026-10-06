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

/** The notices that carry an entry's fix. */
export const FIX_NOTICE_KINDS: readonly NoticeKind[] = [
  "hit",
  "near",
  "doubted",
];

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

/** A claim hint never exceeds this many tokens by estimateTokens(). */
export const CLAIM_HINT_MAX_TOKENS = 60;

/** How long ago, as a hint says it: seconds, then minutes, then hours. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

/**
 * The notice for an agent that hit an entry another agent is diagnosing: who,
 * for how long, and that the fix will follow. It only informs (design Q4).
 *
 * @param id - the entry.
 * @param holder - the diagnosing agent's name.
 * @param elapsedMs - how long the holder has been on it.
 */
export function claimHintText(
  id: string,
  holder: string,
  elapsedMs: number,
): string {
  const render = (name: string) =>
    `${NOTICE_PREFIX} ${id}: ${name} has been diagnosing this for ${elapsedText(elapsedMs)}. Its fix will be passed to you when it is recorded.`;
  const fits = (n: number) => {
    const text = render(clip(holder, n));
    return withinCaps(text) && estimateTokens(text) <= CLAIM_HINT_MAX_TOKENS;
  };
  const n = largest(1, Math.max(1, Array.from(holder).length), fits);
  return hardClip(render(clip(holder, n ?? 1)));
}

// ---------------------------------------------------------------------------
// Caps

/**
 * The notice budget (§7). Every limit can only be tightened: the counts
 * lowered, and `renewAfterSteps` raised.
 */
export interface CapLimits {
  perStep: number;
  perTurn: number;
  perIdPerSession: number;
  /** For an entry whose status is `fixed`. */
  fixedPerSession: number;
  /**
   * Steps after which a long turn's budget starts again, as a new turn's
   * would. A headless run is one turn however long it works, so without this
   * it would hear three notices in all.
   */
  renewAfterSteps: number;
}

export const DEFAULT_CAP_LIMITS: CapLimits = {
  perStep: 1,
  perTurn: 3,
  perIdPerSession: 2,
  fixedPerSession: 1,
  renewAfterSteps: 10,
};

/** CapTracker's counts as plain data, so a hook process can save them between calls. */
export interface CapSnapshot {
  step: number;
  turn: number;
  /** Steps since the turn's budget last started. */
  steps: number;
  perId: Record<string, number>;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;

/**
 * Counts one session's notices. Create one per session; call beginTurn() and
 * beginStep() at those boundaries, and tryEmit() before each notice.
 */
export class CapTracker {
  readonly limits: CapLimits;
  private step = 0;
  private turn = 0;
  private steps = 0;
  private readonly perId = new Map<string, number>();

  /** @param limits - tighter limits; a looser value is ignored. */
  constructor(limits: Partial<CapLimits> = {}) {
    const l = { ...DEFAULT_CAP_LIMITS };
    for (const key of Object.keys(l) as (keyof CapLimits)[])
      l[key] =
        key === "renewAfterSteps"
          ? Math.max(l[key], limits[key] ?? l[key])
          : Math.min(l[key], limits[key] ?? l[key]);
    this.limits = l;
  }

  /**
   * A tracker carrying on from saved counts. Anything malformed in the
   * snapshot counts as zero, so a damaged file can only make antibody quieter
   * for a moment, never louder.
   *
   * @param snapshot - what snapshot() returned, or undefined for a new session.
   * @param limits - as for the constructor.
   */
  static restore(
    snapshot: Partial<CapSnapshot> | undefined,
    limits: Partial<CapLimits> = {},
  ): CapTracker {
    const caps = new CapTracker(limits);
    caps.step = count(snapshot?.step);
    caps.turn = count(snapshot?.turn);
    caps.steps = count(snapshot?.steps);
    const perId = snapshot?.perId;
    if (typeof perId === "object" && perId !== null)
      for (const [id, used] of Object.entries(perId))
        if (count(used) > 0) caps.perId.set(id, count(used));
    return caps;
  }

  /** The counts, for restore() in the next hook process. */
  snapshot(): CapSnapshot {
    return {
      step: this.step,
      turn: this.turn,
      steps: this.steps,
      perId: Object.fromEntries(this.perId),
    };
  }

  /** A new turn: the turn and step budgets start again. */
  beginTurn(): void {
    this.turn = 0;
    this.step = 0;
    this.steps = 0;
  }

  /**
   * A new step within the turn: the step budget starts again, and so does the
   * turn's once the turn has gone on for `renewAfterSteps` steps.
   */
  beginStep(): void {
    this.step = 0;
    if (++this.steps >= this.limits.renewAfterSteps) {
      this.turn = 0;
      this.steps = 0;
    }
  }

  /**
   * Take one notice from every budget, if every budget has one left.
   *
   * @param id - the entry the notice is about.
   * @param fixed - whether the entry's status is `fixed`.
   * @param promised - the notice carries a fix the session was told it would
   *   be given (a claim hint's promise): the turn's budget does not hold it
   *   back, though the step's and the entry's still do.
   * @returns whether the notice may be emitted; nothing is taken when not.
   */
  tryEmit(id: string, fixed = false, promised = false): boolean {
    const used = this.perId.get(id) ?? 0;
    const perId = fixed
      ? this.limits.fixedPerSession
      : this.limits.perIdPerSession;
    if (
      this.step >= this.limits.perStep ||
      (!promised && this.turn >= this.limits.perTurn) ||
      used >= perId
    )
      return false;
    this.step++;
    this.turn++;
    this.perId.set(id, used + 1);
    return true;
  }
}
