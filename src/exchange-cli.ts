// The commands that move fixes between clones (src/exchange.ts):
//
//   antibody export [--out FILE | --print]   write the fleet's fixes to ANTIBODIES.md
//
// Each takes the repository the working directory is in, and exits 0 on
// success, 1 when the memory cannot be read, and 2 on usage.
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { worktreeRoot } from "./agent";
import type { CliIo, McpDeps } from "./cli";
import { EXCHANGE_FILE, exportDocument } from "./exchange";
import { filesIn, memoryDir } from "./paths";
import { createStore, nodeStoreFs, writeFileAtomic } from "./store";
import type { Entry } from "./store";

const EXPORT_USAGE = `usage: antibody export [--out FILE | --print]
  --out FILE  write FILE instead of ${EXCHANGE_FILE} in the repository root
  --print     print the document instead of writing a file
`;

/** The memory's entries as the document holds them, or the reason it cannot be read. */
async function readEntries(
  cwd: string,
  io: CliIo,
  deps: McpDeps,
): Promise<{ entries: Entry[] } | { error: string }> {
  let memory: string;
  try {
    memory = memoryDir(cwd, deps.git, io.env);
  } catch (error) {
    return { error: (error as Error).message };
  }
  try {
    const document = await createStore(filesIn(memory)).read();
    return { entries: document.blocks.map((b) => b.entry) };
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
  const read = await readEntries(cwd, io, deps);
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
