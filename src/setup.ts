// `antibody setup <harness>`: register antibody's hooks and MCP server in a
// harness's own settings, for harnesses that read hooks from a settings file
// rather than from a plugin. Claude Code installs the plugin instead.
//
// Gemini CLI reads hooks and MCP servers from ~/.gemini/settings.json:
//
//   "hooks": { "<Event>": [{ "hooks": [{ "type": "command", "name": …,
//                                         "command": …, "timeout": ms }] }] },
//   "mcpServers": { "<name>": { "command": …, "args": [ … ] } }
//
// Every entry antibody writes is named "antibody", so running setup again
// replaces its own entries and nothing else, and --remove takes them out.
// The rest of the file is left as it was. A file that is not plain JSON is
// never overwritten: Gemini CLI allows comments in it, which a rewrite would
// lose.
import { dirname, join, resolve } from "node:path";
import type { CliIo } from "./cli";
import { GEMINI, GEMINI_EVENTS } from "./gemini";
import { nodeFs } from "./lazy";

/** The name every hook and MCP server antibody registers goes by. */
export const SETUP_NAME = "antibody";

/** A Gemini CLI hook's time limit, in milliseconds. */
export const GEMINI_HOOK_TIMEOUT_MS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A path as one shell word, for a command string a shell will run. */
export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", `'"'"'`)}'`;
}

/** Whether a hook definition holds only antibody's hooks. */
function ours(definition: unknown): boolean {
  return (
    isRecord(definition) &&
    Array.isArray(definition.hooks) &&
    definition.hooks.length > 0 &&
    definition.hooks.every((h) => isRecord(h) && h.name === SETUP_NAME)
  );
}

/**
 * Gemini CLI settings with antibody's hooks and MCP server added, or taken
 * out. Other entries, and every other setting, are kept as they were.
 *
 * @param settings - the parsed settings.json, or {} when there is none.
 * @param bundle - the absolute path of dist/antibody.mjs.
 * @param node - the Node.js executable the hooks run.
 * @param remove - take antibody's entries out instead of adding them.
 * @returns the new settings; the input is not changed.
 */
export function geminiSettings(
  settings: Record<string, unknown>,
  bundle: string,
  node: string,
  remove = false,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...settings };
  const hooks: Record<string, unknown> = isRecord(settings.hooks)
    ? { ...settings.hooks }
    : {};
  const command = `${shellQuote(node)} ${shellQuote(bundle)} hook ${GEMINI}`;
  for (const event of Object.keys(GEMINI_EVENTS)) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(
      (definition) => !ours(definition),
    );
    if (!remove)
      kept.push({
        hooks: [
          {
            type: "command",
            name: SETUP_NAME,
            command,
            timeout: GEMINI_HOOK_TIMEOUT_MS,
          },
        ],
      });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  const servers: Record<string, unknown> = isRecord(settings.mcpServers)
    ? { ...settings.mcpServers }
    : {};
  if (remove) delete servers[SETUP_NAME];
  else servers[SETUP_NAME] = { command: node, args: [bundle, "mcp", GEMINI] };
  if (Object.keys(servers).length > 0) next.mcpServers = servers;
  else delete next.mcpServers;
  return next;
}

/** What `antibody setup` needs from the machine; injected in tests. */
export interface SetupDeps {
  /** The home directory; $HOME by default. */
  home?: string;
  /** The bundle the hooks run; the running file by default. */
  bundle?: string;
}

const SETUP_USAGE = `usage: antibody setup gemini [--settings <file>] [--remove] [--print]
  --settings <file>  the settings file (default ~/.gemini/settings.json)
  --remove           take antibody's hooks and MCP server out again
  --print            print the new settings instead of writing them
`;

/**
 * `antibody setup gemini`: add antibody's hooks and MCP server to Gemini CLI's
 * settings, or take them out.
 *
 * @param args - the arguments after `setup`.
 * @param io - stdout and stderr, and the environment.
 * @param deps - the home directory and the bundle path; injected in tests.
 * @returns the exit code: 0, 1 when the settings cannot be read, 2 on usage.
 */
export async function runSetup(
  args: readonly string[],
  io: Pick<CliIo, "stdout" | "stderr" | "env">,
  deps: SetupDeps = {},
): Promise<number> {
  const usage = (problem: string) => {
    io.stderr(`antibody: ${problem}\n${SETUP_USAGE}`);
    return 2;
  };
  let harness: string | undefined;
  let file: string | undefined;
  let remove = false;
  let print = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--remove") remove = true;
    else if (arg === "--print") print = true;
    else if (arg === "--settings") {
      file = args[++i];
      if (file === undefined) return usage("--settings needs a file");
    } else if (arg.startsWith("-")) return usage(`unknown option: ${arg}`);
    else if (harness === undefined) harness = arg;
    else return usage(`unexpected argument: ${arg}`);
  }
  if (harness !== GEMINI)
    return usage(
      harness === undefined
        ? "setup needs a harness"
        : `setup does not know ${harness}`,
    );

  const home = deps.home ?? io.env.HOME ?? "";
  const path = resolve(file ?? join(home, ".gemini", "settings.json"));
  let settings: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = nodeFs.readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      io.stderr(`antibody: cannot read ${path}: ${String(error)}\n`);
      return 1;
    }
  }
  if (text !== undefined && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed)) settings = parsed;
    else if (print)
      // Gemini CLI allows comments in its settings, which antibody does not
      // rewrite: print its own entries alone, to merge by hand.
      io.stderr(
        `antibody: ${path} is not plain JSON; printing antibody's entries alone.\n`,
      );
    else {
      io.stderr(
        `antibody: ${path} is not plain JSON (comments, perhaps), so it was left as it was. Run 'antibody setup gemini --print' and merge the entries by hand.\n`,
      );
      return 1;
    }
  }

  const bundle = deps.bundle ?? nodeFs.realpathSync(process.argv[1] as string);
  const next = geminiSettings(settings, bundle, "node", remove);
  const json = `${JSON.stringify(next, null, 2)}\n`;
  if (print) {
    io.stdout(json);
    return 0;
  }
  nodeFs.mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.antibody-${process.pid}.tmp`;
  nodeFs.writeFileSync(temp, json);
  nodeFs.renameSync(temp, path);
  io.stdout(
    remove
      ? `Removed antibody's hooks and MCP server from ${path}.\n`
      : `Added antibody's hooks (${Object.keys(GEMINI_EVENTS).join(", ")}) and MCP server to ${path}.\nRestart Gemini CLI to load them.\n`,
  );
  return 0;
}
