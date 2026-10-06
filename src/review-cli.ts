// The commands a person uses on what waits for review (src/review.ts):
//
//   antibody review              read every entry that holds something back
//   antibody allow ID... | --all approve entries, so agents see them
//
// What waits came from outside this machine, so it is shown as text to read,
// never to run: control characters and hidden characters are taken out of
// everything printed. Both commands exit 0 on success, 1 when the memory
// cannot be read or an ID is not one that waits, and 2 on usage.
import type { CliIo, McpDeps } from "./cli";
import { plain } from "./exchange";
import { openMemory } from "./memory-cli";
import { clip, oneLine } from "./notice";
import { REVIEW_KEY, heldParts, pendingReview } from "./review";
import type { Entry } from "./store";

const REVIEW_USAGE = "usage: antibody review\n";

const ALLOW_USAGE = `usage: antibody allow ID... | --all
  ID     an entry that waits for review, as antibody review shows it (E-0004, e4, 4)
  --all  every entry that waits
`;

/** What an entry holds back, in words. */
function holding(entry: Entry): string {
  const held = heldParts(entry.meta);
  return held.fix && held.text
    ? "its fix and its text"
    : held.fix
      ? "its fix"
      : "its text";
}

const INDENT = "            ";

/** A text for the screen: plain, clipped, its lines under a label. */
function field(label: string, text: string, max: number): string[] {
  const lines = plain(text)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
  if (lines.length === 0) return [];
  const body = clip(lines.join("\n"), max).split("\n");
  return [
    `  ${`${label}:`.padEnd(INDENT.length - 2)}${body[0]}`,
    ...body.slice(1).map((l) => `${INDENT}${l}`),
  ];
}

/** One held entry as `antibody review` shows it. */
function describe(entry: Entry): string[] {
  return [
    `${entry.id} · ${clip(oneLine(plain(entry.title)), 200)}  (holds ${holding(entry)})`,
    ...field("category", oneLine(plain(entry.category)), 100),
    ...field("trigger", oneLine(plain(entry.trigger)), 200),
    ...field("sample", entry.raw, 500),
    ...field("fix", entry.fix, 1000),
    ...field("notes", entry.notes, 300),
    "",
  ];
}

/**
 * `antibody review`: print every entry that holds something back for a
 * person, with the text agents are not yet shown.
 *
 * @param args - the arguments after `review`; none are taken.
 * @param io - stdout for the entries, stderr for errors, the environment.
 * @param deps - the working directory and git; injected in tests.
 */
export async function runReview(
  args: readonly string[],
  io: CliIo,
  deps: McpDeps = {},
): Promise<number> {
  if (args.length > 0) {
    io.stderr(`antibody: review takes no arguments\n${REVIEW_USAGE}`);
    return 2;
  }
  const memory = await openMemory(deps.cwd ?? process.cwd(), io, deps);
  if ("error" in memory) {
    io.stderr(`antibody: ${memory.error}\n`);
    return 1;
  }
  const waiting = memory.entries.filter(pendingReview);
  if (waiting.length === 0) {
    io.stdout("Nothing waits for review.\n");
    return 0;
  }
  io.stdout(
    [
      ...waiting.flatMap(describe),
      `${waiting.length} ${waiting.length === 1 ? "entry waits" : "entries wait"} for review. Agents see none of it yet.`,
      `Approve with: antibody allow ${waiting.map((e) => e.id).join(" ")}`,
      "or all of it with: antibody allow --all",
      "",
    ].join("\n"),
  );
  return 0;
}

// The number in an ID as a person may type it: E-0004, e-4, E4, 4.
const idNumber = (text: string): number | undefined => {
  const m = /^(?:[A-Za-z]+-?)?0*(\d+)$/.exec(text.trim());
  return m === null ? undefined : Number(m[1]);
};

/**
 * `antibody allow`: approve entries that wait for review, which clears the
 * mark, so agents see their fix and text from their next hook call. Either
 * every ID is one that waits, or nothing is approved.
 *
 * @param args - entry IDs, or `--all`.
 * @param io - stdout for the report, stderr for errors, the environment.
 * @param deps - the working directory and git; injected in tests.
 */
export async function runAllow(
  args: readonly string[],
  io: CliIo,
  deps: McpDeps = {},
): Promise<number> {
  const all = args.includes("--all");
  const ids = args.filter((a) => a !== "--all");
  const unknown = ids.find((a) => a.startsWith("-"));
  if (
    unknown !== undefined ||
    (all && ids.length > 0) ||
    (!all && ids.length === 0)
  ) {
    io.stderr(
      unknown === undefined
        ? `antibody: give entry IDs, or --all\n${ALLOW_USAGE}`
        : `antibody: unknown option: ${unknown}\n${ALLOW_USAGE}`,
    );
    return 2;
  }
  const memory = await openMemory(deps.cwd ?? process.cwd(), io, deps);
  if ("error" in memory) {
    io.stderr(`antibody: ${memory.error}\n`);
    return 1;
  }

  const waiting = memory.entries.filter(pendingReview);
  const chosen: Entry[] = [];
  const problems: string[] = [];
  if (all) chosen.push(...waiting);
  else
    for (const id of ids) {
      const n = idNumber(id);
      const entry = memory.entries.find(
        (e) => n !== undefined && idNumber(e.id) === n,
      );
      if (entry === undefined) problems.push(`no entry ${clip(plain(id), 40)}`);
      else if (!pendingReview(entry))
        problems.push(`${entry.id} is not waiting for review`);
      else if (!chosen.includes(entry)) chosen.push(entry);
    }
  if (problems.length > 0) {
    io.stderr(`antibody: ${problems.join("; ")}. Nothing was approved.\n`);
    return 1;
  }
  if (chosen.length === 0) {
    io.stdout("Nothing waits for review.\n");
    return 0;
  }
  for (const entry of chosen)
    await memory.store.update(entry.id, { meta: { [REVIEW_KEY]: null } });
  io.stdout(
    `Approved ${chosen.map((e) => e.id).join(", ")}. Agents see ${chosen.length === 1 ? "it" : "them"} from their next hook call.\n`,
  );
  return 0;
}
