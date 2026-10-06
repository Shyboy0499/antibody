// A fresh clone's first session takes in the fixes its repository committed
// (design §4.3). When the memory has no entries document yet and the
// repository root holds an ANTIBODIES.md export, the session start imports it
// as `antibody import` would: every fix held for a person's review, so no
// agent is shown any of it before then. It happens once per clone - a marker
// in the memory directory, created exclusively, keeps two sessions starting
// together from importing twice, and later sessions find the document there.
//
// ANTIBODY_AUTO_IMPORT=0 turns it off; `antibody import` still works.
import { join } from "node:path";
import { EXCHANGE_FILE } from "./exchange";
import { importDocument } from "./exchange-cli";
import { nodeFs } from "./lazy";
import { NOTICE_PREFIX } from "./notice";
import { filesIn } from "./paths";
import { createStore, nodeStoreFs } from "./store";
import type { StoreFs } from "./store";

/** The environment variable that turns the import off when set to `0`. */
export const AUTO_IMPORT_ENV = "ANTIBODY_AUTO_IMPORT";

/** The marker a clone's memory keeps once its first session has looked. */
export const AUTO_IMPORT_MARKER = ".imported";

/**
 * What the agent is told: that fixes came in, and that a person must review
 * them before any agent sees them.
 *
 * @param count - the fixes imported.
 */
export function autoImportText(count: number): string {
  const [fixes, them] = count === 1 ? ["fix", "it"] : ["fixes", "them"];
  return `${NOTICE_PREFIX} This clone took in ${count} ${fixes} from the committed ${EXCHANGE_FILE}. No agent is shown ${them} until a person reviews ${them}: \`antibody review\`, then \`antibody allow\`.`;
}

/**
 * On a session's start, import the repository's committed export into a
 * memory that has nothing yet.
 *
 * @param memory - the memory directory.
 * @param root - the worktree root, where an export is committed.
 * @param env - the environment, for the switch.
 * @param fs - the file system; injected in tests.
 * @returns how many fixes came in, or undefined when nothing was imported.
 */
export async function importOnFirstSession(
  memory: string,
  root: string,
  env: NodeJS.ProcessEnv,
  fs: StoreFs = nodeStoreFs(),
): Promise<number | undefined> {
  if (env[AUTO_IMPORT_ENV] === "0") return undefined;
  const files = filesIn(memory);
  // The common case, every session after the first: one stat.
  if (nodeFs.existsSync(files.errors)) return undefined;
  const source = join(root, EXCHANGE_FILE);
  if (!nodeFs.existsSync(source)) return undefined;
  await fs.mkdir(memory);
  const marker = join(memory, AUTO_IMPORT_MARKER);
  if (!(await fs.createExclusive(marker, `${new Date().toISOString()}\n`)))
    return undefined;
  const text = await fs.readFile(source);
  if (text === undefined) return undefined;
  const store = createStore(files, {}, fs);
  const outcome = await importDocument(
    { store, entries: (await store.read()).blocks.map((b) => b.entry), files },
    text,
    EXCHANGE_FILE,
  );
  return "error" in outcome || outcome.count === 0 ? undefined : outcome.count;
}
