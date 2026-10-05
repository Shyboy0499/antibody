// Ported from dsh-errkb, src/tools.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). The agent tools of design §5.1: their arguments, matching rules
// and wording come over, renamed from err_* to antibody_*. dsh-errkb's tool
// registry and its in-process write queue do not; here every call opens the
// shared memory afresh, since other agents write to it all the time.
//
// A tool is harness-neutral: a name, a description, a JSON Schema for its
// arguments and a call() that returns text. The MCP server lists and calls
// them; another transport could.
//
// Errors. A wrong argument, an unknown ID, a busy or unreadable memory, or a
// call from outside a git repository comes back as a result with `isError`
// set and one line naming the tool, never as a thrown error.
import { CLAIM_TTL_MS, activeClaim, createClaimsFile } from "./claims";
import type { Claim } from "./claims";
import { extractHeadline, safeErrorText } from "./capture";
import type { FleetDeps } from "./fleet";
import { indexEntries, jaccard, match, tokenize } from "./match";
import type { Hit, IndexedEntry, MatchOptions } from "./match";
import { clip, elapsedText, oneLine } from "./notice";
import { filesIn } from "./paths";
import type { KbFiles } from "./paths";
import { normalize } from "./signature";
import { createStateFile, effectiveEntry } from "./state";
import {
  DEFAULT_STORE_OPTIONS,
  LockTimeoutError,
  ParseError,
  createStore,
  formatId,
  nodeStoreFs,
  systemClock,
} from "./store";
import type { Entry, ErrorStore, StoreClock, StoreFs } from "./store";

/** What a tool call returns: one text for the agent. */
export interface ToolResult {
  text: string;
  /** The call failed; `text` says why in one line. */
  isError: boolean;
}

/** One argument's schema: the JSON Schema subset the tools use. */
export type PropertySchema =
  | { type: "string"; description?: string; enum?: readonly string[] }
  | { type: "boolean"; description?: string }
  | { type: "integer"; description?: string; minimum?: number };

/** A tool's arguments: an object with known properties only. */
export interface InputSchema {
  type: "object";
  properties: Record<string, PropertySchema>;
  required: string[];
  additionalProperties: false;
}

/** One tool, ready to be listed and called. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: InputSchema;
  /** The tool only reads the memory. */
  readOnly: boolean;
  /**
   * Run the tool. Never throws.
   *
   * @param args - the arguments as the agent sent them; checked here.
   */
  call(args: unknown): Promise<ToolResult>;
}

/** Settings the tools read; every one has a default. */
export interface ToolsOptions {
  match: Partial<MatchOptions>;
  /** How long a call waits for the memory's lock before it gives up. */
  lockTimeoutMs: number;
}

export const DEFAULT_TOOLS_OPTIONS: ToolsOptions = {
  match: {},
  lockTimeoutMs: 5_000,
};

/** Who calls the tools, and on which memory. */
export interface ToolsContext {
  /**
   * The memory directory, asked for on every call: it throws
   * NotInGitRepoError when the agent works outside a repository.
   */
  memory: () => string;
  /** The calling agent's display name, as its hooks name it. */
  agent: string;
  /** The session the calls belong to, for the event log. */
  session: string;
  options?: Partial<ToolsOptions>;
  deps?: FleetDeps;
}

/** Closest entries antibody_lookup offers on a miss. */
export const CLOSEST_COUNT = 3;

/** Titles in a list or a closest list are clipped to this. */
export const TITLE_MAX_CHARS = 120;

/** A query quoted back in a miss is clipped to this. */
const QUERY_MAX_CHARS = 80;

const SIGNATURE = /^[0-9a-f]{12}$/i;

/** How a match was found, best first. */
const VIA_RANK = { exact: 0, fuzzy: 1, code: 2 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Check arguments against a tool's schema: an object, no unknown property,
 * every required one present, each of the right type.
 *
 * @param schema - the tool's input schema.
 * @param args - what the agent sent; undefined counts as no arguments.
 * @returns why the arguments do not fit, or undefined when they do.
 */
export function checkArgs(
  schema: InputSchema,
  args: unknown,
): string | undefined {
  const given = args ?? {};
  if (!isRecord(given)) return "arguments must be an object";
  for (const key of Object.keys(given))
    if (!Object.hasOwn(schema.properties, key))
      return `unknown argument ${key}`;
  for (const key of schema.required)
    if (given[key] === undefined) return `${key} is required`;
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = given[key];
    if (value === undefined) continue;
    if (property.type === "string") {
      if (typeof value !== "string") return `${key} must be a string`;
      if (property.enum !== undefined && !property.enum.includes(value))
        return `${key} must be one of ${property.enum.join(", ")}`;
    } else if (property.type === "boolean") {
      if (typeof value !== "boolean") return `${key} must be true or false`;
    } else if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < (property.minimum ?? -Infinity)
    ) {
      return property.minimum === undefined
        ? `${key} must be an integer`
        : `${key} must be an integer of at least ${property.minimum}`;
    }
  }
  return undefined;
}

/** One line, clipped. */
const short = (value: string, max: number) => clip(oneLine(value), max);

/** Similarity rounded for display. */
const round = (n: number) => Math.round(n * 100) / 100;

/** A trimmed string argument, or undefined when it is absent or blank. */
const given = (value: unknown) => {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/** A failure to report as the tool's result. */
class ToolError extends Error {}

/** The memory as one call sees it. */
interface MemoryView {
  files: KbFiles;
  store: ErrorStore;
  /** Every entry, with this machine's hit counts added. */
  entries(): Promise<Entry[]>;
  /** The live claim on a fingerprint, if any. */
  claim(fingerprint: string): Promise<Claim | undefined>;
}

/**
 * Bind the tools to an agent.
 *
 * @param context - the memory, the agent and settings.
 * @returns the tools, in the order design §5.1 lists them.
 */
export function createTools(context: ToolsContext): Tool[] {
  const o: ToolsOptions = { ...DEFAULT_TOOLS_OPTIONS, ...context.options };
  const fs: StoreFs = context.deps?.fs ?? nodeStoreFs();
  const clock: StoreClock = context.deps?.clock ?? systemClock();
  const { idPrefix, idWidth } = DEFAULT_STORE_OPTIONS;
  const idPattern = new RegExp(`^${idPrefix}(\\d+)$`, "i");

  function open(): MemoryView {
    const files = filesIn(context.memory());
    const lock = { lockTimeoutMs: o.lockTimeoutMs };
    const store = createStore(files, lock, fs, clock);
    const state = createStateFile(files, lock, fs, clock);
    const claims = createClaimsFile(
      files,
      { ...lock, ttlMs: CLAIM_TTL_MS },
      fs,
      clock,
    );
    return {
      files,
      store,
      async entries() {
        const [document, machine] = await Promise.all([
          store.read(),
          state.read(),
        ]);
        return document.blocks.map((b) =>
          effectiveEntry(b.entry, machine.state.entries[b.entry.id]),
        );
      },
      async claim(fingerprint) {
        return activeClaim(await claims.read(), fingerprint, clock.now());
      },
    };
  }

  /** The ID number in an ID-shaped string, or undefined. */
  function idNumber(value: string): number | undefined {
    const m = idPattern.exec(value.trim());
    return m === null ? undefined : Number(m[1]);
  }

  /** The entry an ID-shaped string names: `E-7` finds `E-0007`. */
  function byId<T extends { entry: Entry }>(
    list: readonly T[],
    value: string,
  ): T | undefined {
    const n = idNumber(value);
    return n === undefined
      ? undefined
      : list.find((i) => idNumber(i.entry.id) === n);
  }

  /** The canonical spelling of an ID-shaped string, for messages. */
  function canonicalId(value: string): string {
    const n = idNumber(value);
    return n === undefined ? value.trim() : formatId(n, idPrefix, idWidth);
  }

  /**
   * Match free text the way capture does: its headline, signed under a
   * category. With no category, every category in memory is tried and the
   * best hit wins: exact before fuzzy before code, then the higher
   * similarity, then the earlier category.
   */
  function matchText(
    raw: string,
    index: readonly IndexedEntry[],
    category?: string,
  ): Hit | undefined {
    const headline = extractHeadline(raw);
    const message = headline.line === "" ? raw.trim() : headline.line;
    const categories =
      category === undefined
        ? [...new Set(index.map((i) => i.category))]
        : [category];
    let winner: Hit | undefined;
    for (const cat of categories) {
      const found = match(
        {
          category: cat,
          message,
          ...(headline.code === undefined ? {} : { code: headline.code }),
        },
        index,
        o.match,
      );
      if (!found.matched) continue;
      if (
        winner === undefined ||
        VIA_RANK[found.via] < VIA_RANK[winner.via] ||
        (found.via === winner.via && found.similarity > winner.similarity)
      )
        winner = found;
    }
    return winner;
  }

  /** What a thrown value means to the agent, in one line. */
  function failure(error: unknown): string {
    if (error instanceof ToolError) return error.message;
    if (error instanceof LockTimeoutError)
      return "the memory is busy; try again";
    if (error instanceof ParseError)
      return `could not read ANTIBODIES.md: ${error.message}`;
    return safeErrorText(error).message;
  }

  /** A tool whose arguments are checked and whose failures become results. */
  function define(
    name: string,
    description: string,
    readOnly: boolean,
    properties: Record<string, PropertySchema>,
    required: string[],
    body: (
      args: Record<string, unknown>,
      memory: MemoryView,
    ) => Promise<string>,
  ): Tool {
    const inputSchema: InputSchema = {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
    return {
      name,
      description,
      inputSchema,
      readOnly,
      async call(args) {
        const wrong = checkArgs(inputSchema, args);
        if (wrong !== undefined)
          return { text: `${name}: ${wrong}`, isError: true };
        try {
          const text = await body(
            (args ?? {}) as Record<string, unknown>,
            open(),
          );
          return { text, isError: false };
        } catch (error) {
          return { text: `${name}: ${oneLine(failure(error))}`, isError: true };
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // antibody_lookup

  /** Who is diagnosing an entry without a fix, as a line, or "". */
  async function claimLine(memory: MemoryView, entry: Entry): Promise<string> {
    if (oneLine(entry.fix) !== "") return "";
    const claim = await memory.claim(entry.fingerprint);
    if (claim === undefined) return "";
    const elapsed = clock.now().getTime() - Date.parse(claim.since);
    return `${claim.agent} has been diagnosing this for ${elapsedText(elapsed)}; its fix will be recorded here.`;
  }

  async function describe(
    memory: MemoryView,
    entry: Entry,
    via: string,
    full: boolean,
  ): Promise<string> {
    const lines = [
      `${entry.id} · ${entry.title}`,
      `category: ${entry.category} · hits: ${entry.hits} · status: ${entry.status} · matched by ${via}`,
      oneLine(entry.fix) === "" ? "fix: (none recorded)" : `fix: ${entry.fix}`,
    ];
    const claim = await claimLine(memory, entry);
    if (claim !== "") lines.push(claim);
    if (full) lines.push("raw:", entry.raw);
    return lines.join("\n");
  }

  const lookup = define(
    "antibody_lookup",
    "Look up an error in the fleet's shared antibody memory by entry ID, 12-hex fingerprint or the error text itself. Returns the entry with its recorded fix, and which agent is diagnosing it when there is no fix yet, or the closest entries when nothing matches.",
    true,
    {
      query: {
        type: "string",
        description: `An entry ID (${formatId(7, idPrefix, idWidth)}), a 12-hex fingerprint, or the error message.`,
      },
      full: {
        type: "boolean",
        description: "Also return the redacted raw sample. Default false.",
      },
    },
    ["query"],
    async (args, memory) => {
      const q = given(args.query);
      if (q === undefined) throw new ToolError("query is empty");
      const full = args.full === true;
      const index = indexEntries(await memory.entries());

      if (idNumber(q) !== undefined) {
        const found = byId(index, q);
        if (found === undefined)
          throw new ToolError(
            `no entry ${canonicalId(q)} (it may have been archived)`,
          );
        return describe(memory, found.entry, "id", full);
      }
      if (SIGNATURE.test(q)) {
        const found = index.find((i) => i.sig === q.toLowerCase());
        if (found !== undefined)
          return describe(memory, found.entry, "fingerprint", full);
      }
      const hit = matchText(q, index);
      if (hit !== undefined) return describe(memory, hit.entry, hit.via, full);

      const tokens = tokenize(normalize(q));
      const closest = index
        .map((i, order) => ({
          i,
          order,
          similarity: jaccard(tokens, i.tokens),
        }))
        .filter((c) => c.similarity > 0)
        .sort((a, b) => b.similarity - a.similarity || a.order - b.order)
        .slice(0, CLOSEST_COUNT);
      const head = `No entry matches "${short(q, QUERY_MAX_CHARS)}".`;
      if (closest.length === 0) return head;
      return [
        `${head} Closest:`,
        ...closest.map(
          ({ i, similarity }) =>
            `${i.entry.id} ${short(i.entry.title, TITLE_MAX_CHARS)} (similarity ${round(similarity)})`,
        ),
      ].join("\n");
    },
  );

  return [lookup];
}
