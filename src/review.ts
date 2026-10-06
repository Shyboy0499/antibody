// The review gate (design §4.3 and §9): what came from outside this machine's
// fleet - imported from a committed ANTIBODIES.md - stays out of every agent's
// context until a person approves it, the way `direnv allow` works. Text
// someone else wrote is an injection surface, so it is not only a fix that
// waits: the title, the sample and the trigger an agent would read in a lookup
// or a notice are held back too.
//
// An entry's machine fields can carry `review=<parts>`, the parts held, joined
// by `+`:
//
// - `fix`: a fix came from outside onto an error this fleet found. The entry's
//   own text is shown, and only the fix is held back;
// - `text`: the entry's title, category, trigger, sample and notes came from
//   outside. They are held back, and agents see only that the fingerprint
//   exists;
// - `fix+text`: the whole entry came from outside, which is what import
//   writes for an error this machine has not met. A mark this version does
//   not know holds both parts, the safe side.
//
// Every place agents read the memory (the fleet loop and the MCP tools) sees
// an entry through forAgents(): open, without what is held, so an entry whose
// fix is held reads as an error seen before with no fix recorded yet, and the
// agent that meets it claims it and diagnoses it as usual. A person clears the
// mark with `antibody allow`, or by deleting it from the comment by hand. A
// fix an agent records itself clears the `fix` part, since that fix was found
// in this fleet, but not the `text` part: it is still someone else's text.
import type { Entry } from "./store";

/** The machine field that marks what an entry holds for review. */
export const REVIEW_KEY = "review";

/** Parts of an entry that can be held. */
export const HOLD_FIX = "fix";
export const HOLD_TEXT = "text";

/** The mark for an entry that came whole from outside. */
export const REVIEW_ALL = `${HOLD_FIX}+${HOLD_TEXT}`;

/**
 * The mark an entry gets when a person rejects it, just before it moves to
 * the archive. It is not a held part, so it holds everything, which does no
 * harm to an entry that is on its way out; import reads it to leave the entry
 * out next time.
 */
export const REVIEW_REJECTED = "rejected";

/** What a lookup shows in place of an entry's held title. */
export const HELD_TITLE = "(imported, waiting for review)";

/** Which parts of an entry are held, read from its machine fields. */
export function heldParts(meta: Readonly<Record<string, string>>): {
  fix: boolean;
  text: boolean;
} {
  const mark = meta[REVIEW_KEY];
  if (mark === undefined || mark === "") return { fix: false, text: false };
  const parts = mark.split("+");
  if (!parts.every((p) => p === HOLD_FIX || p === HOLD_TEXT))
    return { fix: true, text: true };
  return { fix: parts.includes(HOLD_FIX), text: parts.includes(HOLD_TEXT) };
}

/** Whether something in an entry is waiting for a person to approve it. */
export function pendingReview(entry: Entry): boolean {
  const held = heldParts(entry.meta);
  return held.fix || held.text;
}

/**
 * An entry as agents may see it: unchanged, or, while parts of it wait for a
 * person, without them. A held fix leaves the entry open; a held text leaves
 * the title to displayTitle().
 */
export function forAgents(entry: Entry): Entry {
  const held = heldParts(entry.meta);
  if (!held.fix && !held.text) return entry;
  return {
    ...entry,
    ...(held.fix
      ? {
          fix: "",
          status: entry.status === "fixed" ? ("open" as const) : entry.status,
        }
      : {}),
    ...(held.text
      ? { title: "", category: "", trigger: "", raw: "", notes: "" }
      : {}),
  };
}

/** An entry's title as a lookup shows it. */
export function displayTitle(entry: Entry): string {
  return heldParts(entry.meta).text ? HELD_TITLE : entry.title;
}

/**
 * The change to an entry's machine fields when an agent of this fleet records
 * its fix: the fix is no longer held, the text, if it was, still is.
 *
 * @param meta - the entry's machine fields.
 */
export function afterOwnFix(
  meta: Readonly<Record<string, string>>,
): Record<string, string | null> {
  return { [REVIEW_KEY]: heldParts(meta).text ? HOLD_TEXT : null };
}
