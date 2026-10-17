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
// Codex CLI reads hooks from ~/.codex/hooks.json (or $CODEX_HOME/hooks.json)
// in the same shape, with `timeout` in seconds and no `name`, and asks the user
// to trust new hooks before it runs them. Its MCP servers live in config.toml,
// which setup does not edit: it prints the `codex mcp add` command instead.
//
// Every entry antibody writes is recognisable as its own - named "antibody"
// for Gemini CLI, running `… hook codex` for Codex - so running setup again
// replaces its own entries and nothing else, and --remove takes them out.
// The rest of the file is left as it was. A file that is not plain JSON is
// never overwritten: Gemini CLI allows comments in it, which a rewrite would
// lose.
//
// Every entry starts hooks/launch.cjs, not the bundle, as the Claude Code
// plugin does. The CLI looks `node` up on PATH inside the project, and a
// project that pins an older Node would crash the bundle as it loads; the
// launcher hands over to ANTIBODY_NODE instead, or says why and exits 0.
import { dirname, join, resolve } from "node:path";
import type { CliIo } from "./cli";
import { CODEX, CODEX_EVENTS } from "./codex";
import { GEMINI, GEMINI_EVENTS } from "./gemini";
import { nodeFs } from "./lazy";

/** The name every hook and MCP server antibody registers goes by. */
export const SETUP_NAME = "antibody";

/** A Gemini CLI hook's time limit, in milliseconds. */
export const GEMINI_HOOK_TIMEOUT_MS = 10_000;

/** A Codex CLI hook's time limit, in seconds. */
export const CODEX_HOOK_TIMEOUT_SEC = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The launcher of the checkout a script belongs to.
 *
 * @param script - dist/antibody.mjs, or hooks/launch.cjs itself when setup
 *   runs through the launcher.
 * @returns the absolute path of hooks/launch.cjs beside it.
 */
export function launcherFor(script: string): string {
  return join(dirname(script), "..", "hooks", "launch.cjs");
}

/**
 * A path as one shell word, for a command string a shell will run.
 *
 * The quoting belongs to the shell that runs the command, not to the path:
 * cmd.exe has no single-quote syntax, so Windows paths take `"`, where POSIX
 * shells take `'`.
 *
 * @param path - the path to write as one word.
 * @param platform - the platform of the shell that will run the command;
 *   injected so the Windows form is covered from any host.
 * @returns the path, quoted only when the shell would otherwise split it.
 */
export function shellQuote(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    // cmd.exe splits on spaces and reads ^ & | < > ( ) as syntax, but \ and /
    // are literal, so a clean Windows path stands as it is. Anything else -
    // % included - takes the quoted branch, which keeps the path one word but
    // cannot stop cmd.exe expanding %name% inside quotes: a known limit.
    return /^[\w.@+:\\/-]+$/.test(path) ? path : `"${path}"`;
  }
  return /^[\w@%+=:,./-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", `'"'"'`)}'`;
}

/** Whether a hook definition holds only hooks that pass `isOurs`. */
function onlyOurs(
  definition: unknown,
  isOurs: (hook: Record<string, unknown>) => boolean,
): boolean {
  return (
    isRecord(definition) &&
    Array.isArray(definition.hooks) &&
    definition.hooks.length > 0 &&
    definition.hooks.every((h) => isRecord(h) && isOurs(h))
  );
}

/**
 * A `hooks` section with antibody's definition put on each event, after the
 * definitions it already had, or taken off; empty events are dropped.
 */
function withHooks(
  section: unknown,
  events: readonly string[],
  isOurs: (hook: Record<string, unknown>) => boolean,
  hook: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const hooks: Record<string, unknown> = isRecord(section)
    ? { ...section }
    : {};
  for (const event of events) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(
      (definition) => !onlyOurs(definition, isOurs),
    );
    if (hook !== undefined) kept.push({ hooks: [hook] });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  return hooks;
}

/**
 * Gemini CLI settings with antibody's hooks and MCP server added, or taken
 * out. Other entries, and every other setting, are kept as they were.
 *
 * @param settings - the parsed settings.json, or {} when there is none.
 * @param entry - the absolute path of the script the hooks and the MCP server
 *   start: hooks/launch.cjs.
 * @param node - the Node.js executable the hooks run.
 * @param remove - take antibody's entries out instead of adding them.
 * @returns the new settings; the input is not changed.
 */
export function geminiSettings(
  settings: Record<string, unknown>,
  entry: string,
  node: string,
  remove = false,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...settings };
  const command = `${shellQuote(node)} ${shellQuote(entry)} hook ${GEMINI}`;
  const hooks = withHooks(
    settings.hooks,
    Object.keys(GEMINI_EVENTS),
    (hook) => hook.name === SETUP_NAME,
    remove
      ? undefined
      : {
          type: "command",
          name: SETUP_NAME,
          command,
          timeout: GEMINI_HOOK_TIMEOUT_MS,
        },
  );
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  const servers: Record<string, unknown> = isRecord(settings.mcpServers)
    ? { ...settings.mcpServers }
    : {};
  if (remove) delete servers[SETUP_NAME];
  else servers[SETUP_NAME] = { command: node, args: [entry, "mcp", GEMINI] };
  if (Object.keys(servers).length > 0) next.mcpServers = servers;
  else delete next.mcpServers;
  return next;
}

// A hook runs `… hook codex`: antibody's, whatever script and path it had.
const CODEX_HOOK = / hook codex$/;

/**
 * A Codex CLI hooks.json with antibody's hooks added, or taken out. Other
 * hooks, and every other field, are kept as they were.
 *
 * @param file - the parsed hooks.json, or {} when there is none.
 * @param entry - the absolute path of the script the hooks start:
 *   hooks/launch.cjs.
 * @param node - the Node.js executable the hooks run.
 * @param remove - take antibody's hooks out instead of adding them.
 * @returns the new file; the input is not changed.
 */
export function codexHooks(
  file: Record<string, unknown>,
  entry: string,
  node: string,
  remove = false,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...file };
  const command = `${shellQuote(node)} ${shellQuote(entry)} hook ${CODEX}`;
  const hooks = withHooks(
    file.hooks,
    CODEX_EVENTS,
    (hook) => typeof hook.command === "string" && CODEX_HOOK.test(hook.command),
    remove
      ? undefined
      : { type: "command", command, timeout: CODEX_HOOK_TIMEOUT_SEC },
  );
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/** What `antibody setup` needs from the machine; injected in tests. */
export interface SetupDeps {
  /** The home directory; $HOME by default. */
  home?: string;
  /**
   * The running script, the bundle or the launcher; the running file by
   * default. The hooks start the launcher beside it.
   */
  bundle?: string;
}

const SETUP_USAGE = `usage: antibody setup <gemini|codex> [--settings <file>] [--remove] [--print]
  --settings <file>  the file to change (default ~/.gemini/settings.json,
                     or ~/.codex/hooks.json)
  --remove           take antibody's entries out again
  --print            print the new file instead of writing it
`;

/**
 * `antibody setup <gemini|codex>`: add antibody's hooks (and, for Gemini CLI,
 * its MCP server) to the harness's settings, or take them out.
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
  if (harness !== GEMINI && harness !== CODEX)
    return usage(
      harness === undefined
        ? "setup needs a harness"
        : `setup does not know ${harness}`,
    );

  const home = deps.home ?? io.env.HOME ?? "";
  const path = resolve(
    file ??
      (harness === GEMINI
        ? join(home, ".gemini", "settings.json")
        : join(io.env.CODEX_HOME || join(home, ".codex"), "hooks.json")),
  );
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
        `antibody: ${path} is not plain JSON (comments, perhaps), so it was left as it was. Run 'antibody setup ${harness} --print' and merge the entries by hand.\n`,
      );
      return 1;
    }
  }

  const entry = launcherFor(
    deps.bundle ?? nodeFs.realpathSync(process.argv[1] as string),
  );
  const next = (harness === GEMINI ? geminiSettings : codexHooks)(
    settings,
    entry,
    "node",
    remove,
  );
  const json = `${JSON.stringify(next, null, 2)}\n`;
  if (print) {
    io.stdout(json);
    return 0;
  }
  nodeFs.mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.antibody-${process.pid}.tmp`;
  nodeFs.writeFileSync(temp, json);
  nodeFs.renameSync(temp, path);
  // One line per entry; the lines are joined below.
  const lines =
    harness === GEMINI
      ? remove
        ? [`Removed antibody's hooks and MCP server from ${path}.`]
        : [
            `Added antibody's hooks (${Object.keys(GEMINI_EVENTS).join(", ")}) and MCP server to ${path}.`,
            "Restart Gemini CLI to load them.",
          ]
      : remove
        ? [
            `Removed antibody's hooks from ${path}.`,
            `If you added its MCP server, remove it with: codex mcp remove ${SETUP_NAME}`,
          ]
        : [
            `Added antibody's hooks (${CODEX_EVENTS.join(", ")}) to ${path}.`,
            "Codex runs new hooks once you trust them: review them with /hooks.",
            "To add the MCP server too, run",
            `  codex mcp add ${SETUP_NAME} -- node ${shellQuote(entry)} mcp ${CODEX}`,
          ];
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}
