// Ported from dsh-errkb, src/resolve-detect.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
// Resolution detection (T14): noticing that an error the knowledge base knows
// about has stopped happening, so its fix can be trusted (§3 step 6) and, when
// none is recorded, asked for once (§7, the `captureFix` setting).
//
// Pure: no hooks, no store, no clock. src/plugin.ts feeds it what the
// `tools/result` hook sees and acts on what it reports.
//
// The rule. An entry is *watched* in a session once a tool call there was
// recorded against it - appended as a new entry, or counted as a hit, which
// includes every hit whose fix was injected. The watch names a key: the
// command line for a non-zero exit (`command-exit`), the tool name for a tool
// failure. A later successful call on the same key, in the same session and
// inside the window, *resolves* the entry.
//
// The window is the rest of the turn the entry was last recorded in plus the
// whole next turn ({@link RESOLUTION_WINDOW_TURNS}). A fix normally lands in
// the same turn; the next turn covers "fix it, and the user re-runs it". Any
// later success is too far from the failure to say anything about it, so the
// watch lapses.
//
// Recurrence. Every new recording of the entry replaces its watch: the window
// starts again from the recurrence, and the key becomes the one that failed
// last. So a success that only follows an older occurrence - the entry failed
// on tool A, then again on tool B, then A succeeded - resolves nothing; a
// success on B afterwards does.
//
// The model's free text is never parsed for a fix: `err_record` (T15), through
// the recorder's recordFix(), is the only way one is written.
import { exitCode } from "./capture";

/** Turns after the one an entry was last recorded in that still count. */
export const RESOLUTION_WINDOW_TURNS = 1;

/** Watches kept per session; the least recently recorded goes first. */
export const MAX_WATCHES = 32;

/** Values of the `captureFix` setting. */
export const CAPTURE_FIX_MODES = ["prompt-once", "off"] as const;

/** `prompt-once` asks once per entry and session for a missing fix; `off` never. */
export type CaptureFixMode = (typeof CAPTURE_FIX_MODES)[number];

/**
 * The one-shot prompt for an entry that looks resolved and has no fix. It
 * names `err_record` (T15), the one tool that writes a fix.
 *
 * @param id - the entry.
 */
export function askFixText(id: string): string {
  return `[errkb] ${id} looks resolved. Record the fix with err_record in one sentence so it can be reused.`;
}

/** The parts of one tool call that resolution detection reads. */
export interface ToolCall {
  toolName: string;
  /** The command line, when the call names one. */
  command?: string;
  /** The result is a tool failure. */
  isError: boolean;
  /** The result's text, for its exit code. */
  text: string;
}

/** What one tool call means for resolution. */
export type CallOutcome =
  /** A failure; its recording, if any, is watched under `key`. */
  | { ok: false; key: string }
  /** A success; it resolves the watches under any of `keys`. */
  | { ok: true; keys: string[] };

const toolKey = (toolName: string) => `tool:${toolName}`;

const commandKey = (command: string) =>
  `command:${command.replace(/\s+/g, " ").trim()}`;

/**
 * Classify one tool call for resolution. A tool failure is keyed by the tool,
 * a non-zero exit by its command (by the tool when the call names none), and
 * anything else is a success for both its tool and its command.
 *
 * @param call - the tool name, command and result.
 */
export function callOutcome(call: ToolCall): CallOutcome {
  const command =
    call.command === undefined || call.command.trim() === ""
      ? undefined
      : call.command;
  if (call.isError) return { ok: false, key: toolKey(call.toolName) };
  const code = exitCode(call.text);
  if (code !== undefined && code !== 0)
    return {
      ok: false,
      key: command === undefined ? toolKey(call.toolName) : commandKey(command),
    };
  return {
    ok: true,
    keys: [
      toolKey(call.toolName),
      ...(command === undefined ? [] : [commandKey(command)]),
    ],
  };
}

interface Watch {
  key: string;
  turn: number;
}

/**
 * One session's resolution state: the watched entries, the turn count, and
 * the entries already asked for a fix. Call beginTurn() at every new turn.
 * Every method that takes a turn defaults to the current one; the plugin
 * passes the turn an event happened in, since it acts on it a little later.
 */
export class ResolutionTracker {
  private current = 0;
  private readonly watches = new Map<string, Watch>();
  private readonly asked = new Set<string>();

  /** The turns begun so far; 0 before the first. */
  get turn(): number {
    return this.current;
  }

  /** A new turn: watches older than the window lapse. */
  beginTurn(): void {
    this.current++;
    for (const [id, watch] of this.watches)
      if (!this.open(watch.turn)) this.watches.delete(id);
  }

  /** Whether something from `turn` is still inside the window. */
  open(turn: number): boolean {
    return this.current - turn <= RESOLUTION_WINDOW_TURNS;
  }

  /**
   * A call failing under `key` was recorded against `id`: watch it, from
   * `turn`. A watch already on `id` is replaced - a recurrence.
   */
  occurred(id: string, key: string, turn = this.current): void {
    this.watches.delete(id);
    this.watches.set(id, { key, turn });
    if (this.watches.size > MAX_WATCHES)
      this.watches.delete(this.watches.keys().next().value as string);
  }

  /**
   * A call succeeded under `keys` in `turn`.
   *
   * @returns the entries it resolves, in the order they were recorded; each
   *   stops being watched.
   */
  succeeded(keys: readonly string[], turn = this.current): string[] {
    const resolved: string[] = [];
    for (const [id, watch] of this.watches) {
      if (!keys.includes(watch.key)) continue;
      const after = turn - watch.turn;
      if (after < 0 || after > RESOLUTION_WINDOW_TURNS) continue;
      this.watches.delete(id);
      resolved.push(id);
    }
    return resolved;
  }

  /** The entries being watched, for tests and `err_stats`. */
  watched(): string[] {
    return [...this.watches.keys()];
  }

  /**
   * Take the one fix prompt `id` gets in this session.
   *
   * @returns true the first time for `id`, false ever after.
   */
  ask(id: string): boolean {
    if (this.asked.has(id)) return false;
    this.asked.add(id);
    return true;
  }
}
