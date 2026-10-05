// `antibody watch`: the live fleet view, in the terminal beside the agents.
//
// A few times a second it reads the memory - the new lines of events.jsonl,
// ANTIBODIES.md with this machine's hit counts, claims.json - folds them into
// a FleetView and redraws the screen in place on the terminal's alternate
// screen, so the shell is left as it was on quit. Keys: q (or Ctrl-C) quits,
// space freezes the view and resumes it, and p pauses injection for the whole
// fleet, and resumes it: the hooks go on recording but tell the agents
// nothing, and fixes held meanwhile are delivered once it resumes. f cycles
// the events pane through all events, failures and fixes, and e opens
// ANTIBODIES.md in $VISUAL or $EDITOR, leaving the screen while it runs.
//
// `--once` prints one frame without colours or cursor movement and exits, for
// scripts and for looking at the fleet from a pipe.
import { basename } from "node:path";
import { worktreeRoot } from "./agent";
import { createClaimsFile, emptyClaims } from "./claims";
import type { ClaimsState } from "./claims";
import type { CliIo } from "./cli";
import { readEventsFrom } from "./events";
import type { MemoryEvent } from "./events";
import {
  filesIn,
  injectionPaused,
  memoryDir,
  setInjectionPaused,
} from "./paths";
import type { GitRunner } from "./paths";
import { createStateFile, effectiveEntry } from "./state";
import { createStore } from "./store";
import type { Entry } from "./store";
import { lazyChildProcess } from "./lazy";
import { shellQuote } from "./setup";
import { fleetView } from "./watch-model";
import { EVENT_FILTERS, renderView } from "./watch-render";
import type { EventFilter } from "./watch-render";

/** How often the view is redrawn, in milliseconds. */
export const WATCH_INTERVAL_MS = 500;

/** The events kept in memory between redraws; the view needs far fewer. */
const EVENTS_KEPT = 5_000;

/** What `antibody watch` needs from the machine; injected in tests. */
export interface WatchDeps {
  cwd?: string;
  git?: GitRunner;
  now?: () => Date;
  /** The terminal's size; process.stdout's by default. */
  size?: () => { columns: number; rows: number };
  /** Key presses; process.stdin, in raw mode, by default. */
  keys?: NodeJS.ReadableStream;
  intervalMs?: number;
  /** Runs the editor on a file and waits for it; a shell command by default. */
  edit?: (command: string) => void;
}

// Terminal control: the alternate screen, the cursor, home.
const ENTER = "\u001b[?1049h\u001b[?25l";
const LEAVE = "\u001b[?25h\u001b[?1049l";
const HOME = "\u001b[H";
const CLEAR = "\u001b[2J";

const WATCH_USAGE = `usage: antibody watch [--once] [--no-color]
  --once      print one frame and exit
  --no-color  draw without colours (also when NO_COLOR is set)
`;

/** Reads the memory incrementally: events from where the last read stopped. */
export function memoryReader(memory: string) {
  const files = filesIn(memory);
  const store = createStore(files);
  const state = createStateFile(files);
  const claimsFile = createClaimsFile(files);
  let offset = 0;
  let events: MemoryEvent[] = [];
  return async (): Promise<{
    events: MemoryEvent[];
    entries: Entry[];
    claims: ClaimsState;
    paused: boolean;
  }> => {
    const tail = await readEventsFrom(files.events, offset);
    // The log was replaced or shortened: start again with what it holds now.
    if (tail.offset < offset) events = [];
    offset = tail.offset;
    events = [...events, ...tail.events].slice(-EVENTS_KEPT);
    const [document, machine, claims] = await Promise.all([
      store.read().catch(() => ({ preamble: "", blocks: [] })),
      state.read(),
      claimsFile.read().catch(() => emptyClaims()),
    ]);
    const entries = document.blocks.map((b) =>
      effectiveEntry(b.entry, machine.state.entries[b.entry.id]),
    );
    return { events, entries, claims, paused: injectionPaused(memory) };
  };
}

/**
 * `antibody watch`: draw the fleet view until q, or once with `--once`.
 *
 * @param args - the arguments after `watch`.
 * @param io - stdout for the screen, stderr for errors, the environment.
 * @param deps - the directory, the clock, the terminal; injected in tests.
 * @returns 0, 1 outside a repository, 2 on usage.
 */
export async function runWatch(
  args: readonly string[],
  io: CliIo,
  deps: WatchDeps = {},
): Promise<number> {
  let once = false;
  let color = io.env.NO_COLOR === undefined || io.env.NO_COLOR === "";
  for (const arg of args) {
    if (arg === "--once") once = true;
    else if (arg === "--no-color") color = false;
    else {
      io.stderr(`antibody: unknown option: ${arg}\n${WATCH_USAGE}`);
      return 2;
    }
  }
  const cwd = deps.cwd ?? process.cwd();
  let memory: string;
  try {
    memory = memoryDir(cwd, deps.git, io.env);
  } catch (error) {
    io.stderr(`antibody: ${(error as Error).message}\n`);
    return 1;
  }
  const repo = basename(worktreeRoot(cwd, deps.git));
  const now = deps.now ?? (() => new Date());
  const size =
    deps.size ??
    (() => ({
      // Off a terminal (--once into a pipe), COLUMNS and LINES say the size.
      columns: process.stdout.columns || Number(io.env.COLUMNS) || 80,
      rows: process.stdout.rows || Number(io.env.LINES) || 24,
    }));
  const read = memoryReader(memory);
  let frozen = false;
  let filter: EventFilter = "all";
  let last = await read();
  const frame = (colours: boolean) => {
    const { columns, rows } = size();
    const view = fleetView(last.events, last.entries, last.claims, now());
    return renderView(view, {
      width: columns,
      height: rows,
      color: colours,
      now: now(),
      repo,
      frozen,
      paused: last.paused,
      filter,
    });
  };

  if (once) {
    io.stdout(`${frame(false).join("\n")}\n`);
    return 0;
  }

  const keys = deps.keys ?? process.stdin;
  const raw = keys as NodeJS.ReadStream;
  if (raw.isTTY === true) raw.setRawMode(true);
  io.stdout(ENTER);
  let drawn = "";
  const draw = () => {
    // A new size leaves the old frame's cells behind: clear them first.
    const { columns, rows } = size();
    const shape = `${columns}x${rows}`;
    io.stdout(
      (shape === drawn ? HOME : CLEAR + HOME) + frame(color).join("\r\n"),
    );
    drawn = shape;
  };
  draw();
  return new Promise<number>((done) => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      const next = frozen ? Promise.resolve(last) : read();
      next
        .then((data) => {
          last = data;
          draw();
        })
        .finally(() => {
          busy = false;
        });
    }, deps.intervalMs ?? WATCH_INTERVAL_MS);
    const onKey = (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (text.includes("q") || text.includes("\u0003")) {
        clearInterval(timer);
        keys.off("data", onKey);
        if (raw.isTTY === true) raw.setRawMode(false);
        if (deps.keys === undefined) process.stdin.pause();
        io.stdout(LEAVE);
        done(0);
      } else if (text.includes(" ")) {
        frozen = !frozen;
        draw();
      } else if (text.includes("p")) {
        setInjectionPaused(memory, !last.paused);
        last = { ...last, paused: !last.paused };
        draw();
      } else if (text.includes("f")) {
        filter =
          EVENT_FILTERS[
            (EVENT_FILTERS.indexOf(filter) + 1) % EVENT_FILTERS.length
          ] ?? "all";
        draw();
      } else if (text.includes("e")) {
        // Hand the terminal to the editor, then take it back.
        const editor = io.env.VISUAL || io.env.EDITOR || "vi";
        io.stdout(LEAVE);
        if (raw.isTTY === true) raw.setRawMode(false);
        (deps.edit ?? runEditor)(
          `${editor} ${shellQuote(filesIn(memory).errors)}`,
        );
        if (raw.isTTY === true) raw.setRawMode(true);
        io.stdout(ENTER);
        drawn = "";
        void read().then((data) => {
          last = data;
          draw();
        });
      }
    };
    keys.on("data", onKey);
  });
}

/** Run an editor command in a shell on this terminal, and wait for it. */
function runEditor(command: string): void {
  lazyChildProcess().spawnSync(command, { shell: true, stdio: "inherit" });
}
