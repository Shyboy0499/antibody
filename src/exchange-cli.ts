// The commands that move fixes between clones (src/exchange.ts):
//
//   antibody export [--out FILE | --print]   write the fleet's fixes to ANTIBODIES.md
//   antibody import [FILE] [--dry-run]       read fixes from a committed file
//
// Each takes the repository the working directory is in, and exits 0 on
// success, 1 when the memory cannot be read, and 2 on usage.
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { worktreeRoot } from "./agent";
import type { CliIo, McpDeps } from "./cli";
import {
  EXCHANGE_FILE,
  IMPORT_MAX_BYTES,
  exportDocument,
  holdImportedFix,
  planImport,
} from "./exchange";
import type { ImportPlan, Skipped } from "./exchange";
import { filesIn, memoryDir } from "./paths";
import {
  DEFAULT_STORE_OPTIONS,
  ParseError,
  createStore,
  nodeStoreFs,
  parseDocument,
  writeFileAtomic,
} from "./store";
import type { Entry, ErrorStore } from "./store";

const EXPORT_USAGE = `usage: antibody export [--out FILE | --print]
  --out FILE  write FILE instead of ${EXCHANGE_FILE} in the repository root
  --print     print the document instead of writing a file
`;

/** The memory's store and its entries as the document holds them, or why not. */
async function openMemory(
  cwd: string,
  io: CliIo,
  deps: McpDeps,
): Promise<{ store: ErrorStore; entries: Entry[] } | { error: string }> {
  let memory: string;
  try {
    memory = memoryDir(cwd, deps.git, io.env);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const store = createStore(filesIn(memory));
  try {
    const document = await store.read();
    return { store, entries: document.blocks.map((b) => b.entry) };
  } catch (error) {
    return {
      error: `could not read ANTIBODIES.md: ${(error as Error).message}`,
    };
  }
}

/** A path as a person would type it: relative to `cwd` when it is below it. */
function shown(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

/**
 * `antibody export`: write the fixes this fleet found to ANTIBODIES.md in the
 * repository root, redacted again, for a person to look over and commit. It
 * writes nothing when there is nothing to export, and will not overwrite a
 * file that is not an antibody export.
 *
 * @param args - the arguments after `export`.
 * @param io - stdout for the report, stderr for errors, the environment.
 * @param deps - the working directory and git; injected in tests.
 */
export async function runExport(
  args: readonly string[],
  io: CliIo,
  deps: McpDeps = {},
): Promise<number> {
  let out: string | undefined;
  let print = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--print") print = true;
    else if (arg === "--out" && args[i + 1] !== undefined)
      out = args[++i] as string;
    else {
      io.stderr(`antibody: unknown option: ${arg}\n${EXPORT_USAGE}`);
      return 2;
    }
  }
  if (print && out !== undefined) {
    io.stderr(
      `antibody: --print and --out do not go together\n${EXPORT_USAGE}`,
    );
    return 2;
  }

  const cwd = deps.cwd ?? process.cwd();
  const read = await openMemory(cwd, io, deps);
  if ("error" in read) {
    io.stderr(`antibody: ${read.error}\n`);
    return 1;
  }
  const { text, exported } = exportDocument(read.entries);
  const left = read.entries.length - exported;
  // With --print the document owns stdout: anything else goes to stderr.
  const say = print ? io.stderr : io.stdout;
  if (exported === 0) {
    say(
      "Nothing to export: no entry has a fix that was found in this repository yet.\n",
    );
    return 0;
  }
  if (print) {
    io.stdout(text);
    return 0;
  }

  const target = resolve(
    cwd,
    out ?? resolve(worktreeRoot(cwd, deps.git), EXCHANGE_FILE),
  );
  const fs = nodeStoreFs();
  const existing = await fs.readFile(target);
  if (
    existing !== undefined &&
    existing !== "" &&
    !existing.startsWith("# ANTIBODIES")
  ) {
    io.stderr(
      `antibody: ${shown(cwd, target)} exists and is not an antibody export; choose another file with --out\n`,
    );
    return 1;
  }
  const name = shown(cwd, target);
  if (existing === text) {
    io.stdout(
      `${name} is up to date (${exported} ${exported === 1 ? "entry" : "entries"}).\n`,
    );
    return 0;
  }
  await fs.mkdir(dirname(target));
  await writeFileAtomic(fs, target, text);
  io.stdout(
    [
      `Exported ${exported} of ${read.entries.length} entries to ${name}.`,
      ...(left > 0
        ? [`${left} left out: no fix yet, or a fix still waiting for review.`]
        : []),
      "Look it over, then commit it.",
      "",
    ].join("\n"),
  );
  return 0;
}

const IMPORT_USAGE = `usage: antibody import [FILE] [--dry-run]
  FILE       the file to read; ${EXCHANGE_FILE} in the repository root by default
  --dry-run  say what would be imported, and change nothing
`;

const WHY: Record<Skipped | "known", string> = {
  known: "already known here",
  "no-fix": "without a working fix",
  duplicate: "repeated in the file",
  "bad-fingerprint": "with a fingerprint that is not one",
  wontfix: "for errors marked wontfix here",
  full: `that did not fit: the memory holds at most ${DEFAULT_STORE_OPTIONS.maxEntries} entries`,
};

/** What an import left out, as "1 already known, 2 without a working fix". */
function leftOut(plan: ImportPlan): string {
  const counts: [Skipped | "known", number][] = [
    ["known", plan.known],
    ...(Object.entries(plan.skipped) as [Skipped, number][]),
  ];
  return counts
    .filter(([, n]) => n > 0)
    .map(([why, n]) => `${n} ${WHY[why]}`)
    .join(", ");
}

/**
 * `antibody import`: read the fixes of a committed ANTIBODIES.md into this
 * clone's memory, where each waits for a person's review (src/review.ts)
 * before any agent sees it. A fix is added as a new entry for an error this
 * machine has not met, or given to an entry it has and has no fix for; an
 * entry that already has a fix keeps it.
 *
 * @param args - the arguments after `import`.
 * @param io - stdout for the report, stderr for errors, the environment.
 * @param deps - the working directory and git; injected in tests.
 */
export async function runImport(
  args: readonly string[],
  io: CliIo,
  deps: McpDeps = {},
): Promise<number> {
  let file: string | undefined;
  let dry = false;
  for (const arg of args) {
    if (arg === "--dry-run") dry = true;
    else if (!arg.startsWith("-") && file === undefined) file = arg;
    else {
      io.stderr(`antibody: unknown option: ${arg}\n${IMPORT_USAGE}`);
      return 2;
    }
  }

  const cwd = deps.cwd ?? process.cwd();
  const memory = await openMemory(cwd, io, deps);
  if ("error" in memory) {
    io.stderr(`antibody: ${memory.error}\n`);
    return 1;
  }
  const target = resolve(
    cwd,
    file ?? resolve(worktreeRoot(cwd, deps.git), EXCHANGE_FILE),
  );
  const name = shown(cwd, target);
  const text = await nodeStoreFs().readFile(target);
  if (text === undefined) {
    io.stderr(`antibody: no such file: ${name}\n`);
    return 1;
  }
  if (Buffer.byteLength(text) > IMPORT_MAX_BYTES) {
    io.stderr(
      `antibody: ${name} is larger than ${IMPORT_MAX_BYTES / 1024} KiB; not importing it\n`,
    );
    return 1;
  }
  let incoming: Entry[];
  try {
    incoming = parseDocument(text).blocks.map((b) => b.entry);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    io.stderr(`antibody: could not read ${name}: ${error.message}\n`);
    return 1;
  }

  const room = Math.max(
    0,
    DEFAULT_STORE_OPTIONS.maxEntries - memory.entries.length,
  );
  const plan = planImport(memory.entries, incoming, room, name);
  const count = plan.add.length + plan.adopt.length;
  const left = leftOut(plan);
  if (count === 0) {
    io.stdout(
      `Nothing to import from ${name}${left === "" ? "" : ` (${left})`}.\n`,
    );
    return 0;
  }
  if (!dry) {
    for (const entry of plan.add) await memory.store.append(entry);
    for (const { id, fix } of plan.adopt)
      await memory.store.update(id, {
        fix,
        status: "fixed",
        meta: holdImportedFix,
      });
  }
  io.stdout(
    [
      `${dry ? "Would import" : "Imported"} ${count} ${count === 1 ? "fix" : "fixes"} from ${name}: ${plan.add.length} for new errors, ${plan.adopt.length} for errors this machine had no fix for.`,
      ...(dry
        ? []
        : [
            "They wait for your review, and no agent sees them until you approve them.",
          ]),
      ...(left === "" ? [] : [`Left out: ${left}.`]),
      "",
    ].join("\n"),
  );
  return 0;
}
