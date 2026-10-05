// The review gate (design §4.3 and §9): a fix that came from outside this
// machine's fleet - imported from a committed ANTIBODIES.md - stays out of
// every agent's context until a person approves it, the way `direnv allow`
// works.
//
// Such an entry carries `review=pending` in its machine fields. Every place
// agents read the memory (the fleet loop and the MCP tools) sees it through
// forAgents(): without its fix, so it reads as an error seen before with no
// fix recorded yet, and the agent that meets it claims it and diagnoses it as
// usual. A person clears the mark with `antibody allow`, or by deleting it
// from the comment by hand. A fix an agent records itself clears it too: that
// fix was found in this fleet.
import type { Entry } from "./store";

/** The machine field that marks an entry as waiting for a person. */
export const REVIEW_KEY = "review";

/** Its value while the entry waits. */
export const REVIEW_PENDING = "pending";

/** Whether an entry's fix is waiting for a person to approve it. */
export function pendingReview(entry: Entry): boolean {
  return entry.meta[REVIEW_KEY] === REVIEW_PENDING;
}

/**
 * An entry as agents may see it: unchanged, or, while its fix waits for a
 * person, without the fix and open again.
 */
export function forAgents(entry: Entry): Entry {
  if (!pendingReview(entry)) return entry;
  return {
    ...entry,
    fix: "",
    status: entry.status === "fixed" ? "open" : entry.status,
  };
}
