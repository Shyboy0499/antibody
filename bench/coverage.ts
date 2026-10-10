// What a run's transcripts say about the commands its traps came through
// (#131, #132).
//
// The table counts a trap as met when the memory says an agent hit it. What the
// memory does not say is which command produced the error: a trap met by
// `npm test 2>&1 | tail -15` and one met by `npm test` land in it the same way.
// The run's transcripts do say - every `Bash` tool call the client made is in
// them - so the two together can answer the one question the real-agent numbers
// rest on: did this run measure piped commands, or something else?
//
// A trap counts as `piped` when a session that met it had run a command
// containing a pipe at or before the meeting. Reading a pipe out of a command
// uses the same test as the pipefail rewrite (src/pipefail.ts), so `a | b`
// counts and `a || b` does not.
import type { MemoryEvent } from "../src/events";
import type { Entry } from "../src/store";
import { trapOfEntries } from "./analyze";
import { TRAPS } from "./traps";
import type { Trap } from "./traps";

/** A pipe between two stages, as the pipefail rewrite tells one. */
const PIPE = /(^|[^|])\|([^|]|$)/;

/** One session's transcript, as the runner kept it. A subagent's shares its parent's session. */
export interface SessionTranscript {
  /** The session the transcript belongs to. */
  session: string;
  /** The transcript's text, one JSON line per event. */
  text: string;
}

/** One Bash tool call a session made. */
export interface ShellCommand {
  /** When it ran, in milliseconds; NaN when the transcript has no timestamp. */
  at: number;
  /** Whether the command contains a pipe. */
  piped: boolean;
}

/** How one trap's meetings went, as far as the transcripts can say. */
export interface TrapCoverage {
  trap: Trap["id"];
  /** Sessions that met the trap, whether or not through a pipe. */
  met: number;
  /** Of those, the ones that had run a piped command first. */
  piped: number;
}

/** What the transcripts say about a run's commands. */
export interface RunCoverage {
  /** Sessions whose transcripts were read. */
  sessions: number;
  /** Sessions that ran at least one Bash command. */
  bash: number;
  /** Sessions that ran at least one command containing a pipe. */
  piped: number;
  traps: TrapCoverage[];
}

/**
 * Every Bash command a transcript holds, oldest first.
 *
 * A transcript line is read defensively: anything that does not parse, or is not
 * an assistant message with a tool call, is skipped, because a transcript is
 * read back from disk and a reader must not throw on one (#131's lesson).
 *
 * @param text - one transcript's text.
 */
export function shellCommands(text: string): ShellCommand[] {
  const found: ShellCommand[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as { timestamp?: unknown; message?: unknown };
    const at =
      typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
    const content = (record.message as { content?: unknown } | undefined)
      ?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const call = item as {
        type?: unknown;
        name?: unknown;
        input?: unknown;
      };
      if (call.type !== "tool_use" || call.name !== "Bash") continue;
      const command = (call.input as { command?: unknown } | undefined)
        ?.command;
      if (typeof command !== "string") continue;
      found.push({ at, piped: PIPE.test(command) });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The commands per session, and the first piped one. */
interface SessionCommands {
  bash: number;
  pipedAt: number[];
}

/** Group transcripts by session: a subagent's is the same session as its parent's. */
function bySession(
  transcripts: readonly SessionTranscript[],
): Map<string, SessionCommands> {
  const sessions = new Map<string, SessionCommands>();
  for (const { session, text } of transcripts) {
    const commands = sessions.get(session) ?? { bash: 0, pipedAt: [] };
    for (const command of shellCommands(text)) {
      commands.bash++;
      if (command.piped) commands.pipedAt.push(command.at);
    }
    sessions.set(session, commands);
  }
  return sessions;
}

/** Whether a session had run a pipe by the time it met a trap. */
function pipedBy(
  commands: SessionCommands | undefined,
  metAt: number,
): boolean {
  if (commands === undefined || commands.pipedAt.length === 0) return false;
  // A meeting with no time to order by still counts: the session ran a pipe, and
  // a transcript with no timestamps cannot say any more than that.
  if (Number.isNaN(metAt)) return true;
  return commands.pipedAt.some((at) => Number.isNaN(at) || at <= metAt);
}

/**
 * What a run's commands were, and whether its traps came through a pipe.
 *
 * A trap is met by a session when the log has a `hit`, `miss` or `hold` for its
 * entry in that session - the same rule the table counts by (bench/analyze.ts) -
 * and is piped when that session had run a piped command first.
 *
 * @param o - the run's transcripts, its events.jsonl and its entries.
 */
export function coverageOf(o: {
  transcripts: readonly SessionTranscript[];
  events: readonly MemoryEvent[];
  entries: readonly Entry[];
}): RunCoverage {
  const sessions = bySession(o.transcripts);
  const trapOfEntry = trapOfEntries(o.entries);
  const metAt = new Map<string, number>();
  for (const e of o.events) {
    if (e.kind !== "hit" && e.kind !== "miss" && e.kind !== "hold") continue;
    const trap = e.id === undefined ? undefined : trapOfEntry.get(e.id);
    if (trap === undefined) continue;
    const key = `${trap}\0${e.session}`;
    if (!metAt.has(key)) metAt.set(key, Date.parse(e.t));
  }
  return {
    sessions: sessions.size,
    bash: [...sessions.values()].filter((s) => s.bash > 0).length,
    piped: [...sessions.values()].filter((s) => s.pipedAt.length > 0).length,
    traps: TRAPS.map((trap) => {
      const meetings = [...metAt].filter(([key]) =>
        key.startsWith(`${trap.id}\0`),
      );
      return {
        trap: trap.id,
        met: meetings.length,
        piped: meetings.filter(([key, at]) =>
          pipedBy(sessions.get(key.slice(trap.id.length + 1)), at),
        ).length,
      };
    }),
  };
}

/** One run's coverage, as the coverage report names it. */
export interface CoverageRow {
  /** The run as the report names it, such as `run-1-on`. */
  run: string;
  /** Its coverage, or undefined for a run that recorded none. */
  coverage?: RunCoverage;
}

const cells = (row: CoverageRow): string[] => {
  const { coverage } = row;
  if (coverage === undefined) return ["-", "-", "-", ...TRAPS.map(() => "-")];
  return [
    String(coverage.sessions),
    String(coverage.bash),
    String(coverage.piped),
    ...TRAPS.map((trap) => {
      const found = coverage.traps.find((t) => t.trap === trap.id);
      if (found === undefined || found.met === 0) return "-";
      return `${found.met} (${found.piped} piped)`;
    }),
  ];
};

/**
 * The coverage report, as Markdown, for the published directory.
 *
 * @param rows - one row per run, in the order the table lists them.
 */
export function renderCoverage(rows: readonly CoverageRow[]): string {
  const lines = [
    "# Piped coverage",
    "",
    "Which commands the run's traps came through, read from the agents' transcripts and the",
    "memory. A trap counts as `piped` when a session that met it had run a command containing",
    "a pipe first (#131); `met (piped)` is the sessions that met it, and how many of those",
    "were piped.",
    "",
    `| Run | Sessions | Ran Bash | Ran a pipe | ${TRAPS.map((t) => t.id).join(" | ")} |`,
    `| --- | ---: | ---: | ---: | ${TRAPS.map(() => "---:").join(" | ")} |`,
    ...rows.map((row) => `| ${row.run} | ${cells(row).join(" | ")} |`),
  ];
  const unread = rows.filter((row) => row.coverage?.bash === 0);
  if (unread.length > 0)
    lines.push(
      "",
      `${unread.length} of ${rows.length} runs hold no Bash command in their transcripts, so`,
      "their coverage is unknown rather than empty: the scripted agents run `npm test`",
      "themselves, without the client, and write no tool call.",
    );
  const missing = rows.filter((row) => row.coverage === undefined);
  if (missing.length > 0)
    lines.push(
      "",
      `${missing.map((row) => row.run).join(", ")} recorded no coverage: they were run`,
      "before the runner kept it, or their transcripts went missing.",
    );
  return `${lines.join("\n")}\n`;
}
