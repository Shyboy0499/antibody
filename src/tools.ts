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
import type { Claim, ClaimsFile } from "./claims";
import { extractHeadline, safeErrorText } from "./capture";
import { appendEvent, readEventsFrom } from "./events";
import type { NewEvent } from "./events";
import { createFleet } from "./fleet";
import type { Fleet, FleetDeps } from "./fleet";
import { indexEntries, jaccard, match, tokenize } from "./match";
import type { Hit, IndexedEntry, MatchOptions } from "./match";
import { FIX_NOTICE_KINDS, clip, elapsedText, oneLine } from "./notice";
import type { NoticeKind, TrustLevel } from "./notice";
import { filesIn } from "./paths";
import type { KbFiles } from "./paths";
import { forAgents } from "./review";
import { normalize, signature } from "./signature";
import { createStateFile, effectiveEntry } from "./state";
import type { MachineState } from "./state";
import {
  DEFAULT_STORE_OPTIONS,
  ENTRY_STATUSES,
  LockTimeoutError,
  ParseError,
  createStore,
  formatId,
  nodeStoreFs,
  systemClock,
} from "./store";
import { fixSig, trustLevel } from "./trust";
import type {
  Entry,
  EntryPatch,
  EntryStatus,
  ErrorStore,
  StoreClock,
  StoreFs,
} from "./store";

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

/** Category of an entry antibody_record creates from a message without one. */
export const DEFAULT_RECORD_CATEGORY = "agent";

/**
 * The diagnosis one fix notice is assumed to replace, in tokens. A
 * re-diagnosis costs 800 to 3,000 tokens of thinking and trial; this takes
 * the low end, so the estimate errs towards too little.
 */
export const ASSUMED_DIAGNOSIS_TOKENS = 800;

/** Scopes antibody_stats counts notices over. */
export const STATS_SCOPES = ["fleet", "agent"] as const;

/** Entries antibody_list returns when `limit` is not given. */
export const DEFAULT_LIST_LIMIT = 20;

/** The most entries antibody_list returns, whatever `limit` says. */
export const MAX_LIST_LIMIT = 200;

/**
 * Fewest distinct tokens a lookup needs before it can match by containment:
 * fewer, and a query like "error" would match everything.
 */
export const CONTAINED_MIN_TOKENS = 3;

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
  /** The memory directory. */
  dir: string;
  files: KbFiles;
  /** state.json: this machine's hit counts and fix trust. */
  machine(): Promise<MachineState>;
  store: ErrorStore;
  claims: ClaimsFile;
  /** The fleet loop, as this agent: antibody_record writes fixes through it. */
  fleet: Fleet;
  /** Append an event as this agent. */
  log(event: Omit<NewEvent, "agent" | "session">): Promise<void>;
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
    const memory = context.memory();
    const files = filesIn(memory);
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
      dir: memory,
      files,
      store,
      claims,
      machine: async () => (await state.read()).state,
      fleet: createFleet(
        memory,
        context.agent,
        context.session,
        lock,
        context.deps,
      ),
      log: (event) =>
        appendEvent(
          files.events,
          { ...event, agent: context.agent, session: context.session },
          clock.now(),
        ),
      async entries() {
        const [document, machine] = await Promise.all([
          store.read(),
          state.read(),
        ]);
        // A fix waiting for a person's review is not shown: src/review.ts.
        return document.blocks.map((b) =>
          forAgents(effectiveEntry(b.entry, machine.state.entries[b.entry.id])),
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

  /**
   * The entry whose sample holds every token of a query, the closest first.
   * An agent that pastes the error line finds the entry a hook recorded with
   * the command and the exit code around it (`pnpm test → Error: …`), which
   * neither the signature nor the similarity threshold would find.
   */
  function containing(
    tokens: ReadonlySet<string>,
    index: readonly IndexedEntry[],
  ): IndexedEntry | undefined {
    if (tokens.size < CONTAINED_MIN_TOKENS) return undefined;
    let best: IndexedEntry | undefined;
    let bestSimilarity = -1;
    for (const indexed of index) {
      if (![...tokens].every((t) => indexed.tokens.has(t))) continue;
      const similarity = jaccard(tokens, indexed.tokens);
      if (similarity > bestSimilarity) {
        best = indexed;
        bestSimilarity = similarity;
      }
    }
    return best;
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
      const contained = containing(tokens, index);
      if (contained !== undefined)
        return describe(memory, contained.entry, "contained text", full);

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

  // -------------------------------------------------------------------------
  // antibody_list

  const list = define(
    "antibody_list",
    "List the entries in the fleet's shared antibody memory: ID, hits, status and title only, no bodies.",
    true,
    {
      cat: {
        type: "string",
        description:
          "Only this category: tool, command, llm, agent, or a display category such as tool / Bash.",
      },
      status: { type: "string", enum: ENTRY_STATUSES },
      limit: {
        type: "integer",
        minimum: 1,
        description: `At most this many entries (default ${DEFAULT_LIST_LIMIT}, at most ${MAX_LIST_LIMIT}).`,
      },
    },
    [],
    async (args, memory) => {
      const limit = Math.min(
        (args.limit as number | undefined) ?? DEFAULT_LIST_LIMIT,
        MAX_LIST_LIMIT,
      );
      const cat = given(args.cat)?.toLowerCase();
      const matches = indexEntries(await memory.entries()).filter(
        (i) =>
          (cat === undefined ||
            i.category.toLowerCase() === cat ||
            i.entry.category.toLowerCase() === cat) &&
          (args.status === undefined || i.entry.status === args.status),
      );
      if (matches.length === 0) return "No entries.";
      const shown = matches.slice(0, limit);
      return [
        ...shown.map(
          ({ entry }) =>
            `${entry.id} (${entry.hits} ${entry.hits === 1 ? "hit" : "hits"}, ${entry.status}) ${short(entry.title, TITLE_MAX_CHARS)}`,
        ),
        `${shown.length} of ${matches.length} shown.`,
      ].join("\n");
    },
  );

  // -------------------------------------------------------------------------
  // antibody_record

  /** Notes with one more line. */
  const withNote = (notes: string, note: string) =>
    notes === "" ? note : `${notes}\n${note}`;

  /**
   * Find the entry a message describes, or append one.
   *
   * Only an exact hit names the entry to update. A near hit writes nothing and
   * comes back as the candidate: a fix recorded on a similar but different
   * entry would later be injected as its known fix.
   *
   * A new entry is appended the way the hooks append one: only by the agent
   * that claims its fingerprint, so two agents recording the same new error at
   * once write one entry. The claim only guards the append and is released
   * straight after.
   */
  async function findOrAppend(
    memory: MemoryView,
    message: string,
    category: string | undefined,
    fields: { fix?: string; status?: EntryStatus; note?: string },
  ): Promise<{ id: string; created: boolean }> {
    const hit = matchText(
      message,
      indexEntries(await memory.entries()),
      category,
    );
    if (hit !== undefined && hit.via !== "exact")
      throw new ToolError(
        `closest match is ${hit.id} (approximate, by ${hit.via}); nothing was written. Call antibody_record with id: "${hit.id}" to confirm, or reword message`,
      );
    if (hit !== undefined) return { id: hit.id, created: false };

    const cat = category ?? DEFAULT_RECORD_CATEGORY;
    const headline = extractHeadline(message);
    const line = headline.line === "" ? message : headline.line;
    const sig = signature(cat, line);
    const outcome = await memory.claims.claim({
      id: sig,
      agent: context.agent,
      session: context.session,
    });
    try {
      // Someone may have appended it between the read and the claim.
      const index = indexEntries(await memory.entries());
      const existing = index.find((i) => i.sig === sig);
      if (existing !== undefined)
        return { id: existing.entry.id, created: false };
      if (!outcome.granted)
        throw new ToolError(
          `${outcome.holder.agent} is recording this error right now; look it up with antibody_lookup in a moment`,
        );
      const { id } = await memory.store.append({
        title: `[${cat}] ${line}`,
        signature: sig,
        category: cat,
        meta: {
          cat,
          ...(headline.code === undefined ? {} : { code: headline.code }),
        },
        raw: message,
        ...(fields.fix === undefined ? {} : { fix: fields.fix }),
        status: fields.status ?? (fields.fix === undefined ? "open" : "fixed"),
        ...(fields.note === undefined ? {} : { notes: fields.note }),
      });
      await memory.log({ kind: "miss", id, text: line });
      if (fields.fix !== undefined)
        await memory.log({ kind: "fix", id, text: fields.fix });
      return { id, created: true };
    } finally {
      if (outcome.granted) await memory.claims.release(sig, context.session);
    }
  }

  /** Change an existing entry: the fix through the fleet, then the rest. */
  async function change(
    memory: MemoryView,
    id: string,
    fields: { fix?: string; status?: EntryStatus; note?: string },
  ): Promise<Entry | undefined> {
    let entry: Entry | undefined;
    if (fields.fix !== undefined) {
      entry = await memory.fleet.recordFix(id, fields.fix);
      if (entry === undefined) return undefined;
    }
    // An explicit status wins over the `fixed` a fix implies.
    if (fields.status !== undefined || fields.note !== undefined) {
      const current = (await memory.store.read()).blocks.find(
        (b) => b.entry.id === id,
      )?.entry;
      if (current === undefined) return undefined;
      const patch: EntryPatch = {};
      if (fields.status !== undefined) patch.status = fields.status;
      if (fields.note !== undefined)
        patch.notes = withNote(current.notes, fields.note);
      entry = await memory.store.update(id, patch);
    }
    return entry;
  }

  const record = define(
    "antibody_record",
    "Record what you learned about an error in the fleet's shared antibody memory, so every other agent gets it. Give exactly one of id (an existing entry) or message (the error text). A message updates an entry only when it matches exactly; on an approximate match nothing is written and the closest entry's ID is returned, so confirm it with id. A new entry is created when nothing matches. A fix marks the entry fixed and is passed to agents waiting for it.",
    false,
    {
      id: {
        type: "string",
        description: `An existing entry, e.g. ${formatId(7, idPrefix, idWidth)}.`,
      },
      message: {
        type: "string",
        description:
          "The error text, when you do not know the ID. Only an exact match updates an existing entry.",
      },
      fix: {
        type: "string",
        description: "What fixed it, in one or two sentences.",
      },
      status: {
        type: "string",
        enum: ENTRY_STATUSES,
        description:
          "fixed, wontfix (never inject it) or open. A fix alone sets fixed.",
      },
      note: {
        type: "string",
        description: "A line added to the entry's notes.",
      },
      category: {
        type: "string",
        description: `For message: the category to match and file under, e.g. tool or command. Default: match any; file new entries under ${DEFAULT_RECORD_CATEGORY}.`,
      },
    },
    [],
    async (args, memory) => {
      const id = given(args.id);
      const message = given(args.message);
      const fix = given(args.fix);
      const note = given(args.note);
      const category = given(args.category);
      const status = args.status as EntryStatus | undefined;
      if ((id === undefined) === (message === undefined))
        throw new ToolError("give exactly one of id and message");
      if (args.fix !== undefined && fix === undefined)
        throw new ToolError("fix is empty");
      const fields = {
        ...(fix === undefined ? {} : { fix }),
        ...(status === undefined ? {} : { status }),
        ...(note === undefined ? {} : { note }),
      };

      let target: { id: string; created: boolean };
      if (id !== undefined) {
        if (Object.keys(fields).length === 0)
          throw new ToolError("nothing to record: give fix, status or note");
        const found = byId(indexEntries(await memory.entries()), id);
        if (found === undefined)
          throw new ToolError(`no entry ${canonicalId(id)}`);
        target = { id: found.entry.id, created: false };
      } else {
        target = await findOrAppend(
          memory,
          message as string,
          category,
          fields,
        );
      }

      let entry: Entry | undefined;
      if (!target.created) entry = await change(memory, target.id, fields);
      entry ??= (await memory.entries()).find((e) => e.id === target.id);
      if (entry === undefined) throw new ToolError(`no entry ${target.id}`);
      const what = target.created ? "Created" : "Updated";
      const hasFix = oneLine(entry.fix) !== "";
      const tail =
        fix !== undefined && entry.status !== "wontfix"
          ? " Agents waiting for it get the fix at their next tool call."
          : !hasFix && entry.status === "open"
            ? " No fix recorded yet."
            : "";
      return `${what} ${entry.id} (status ${entry.status}).${tail}`;
    },
  );

  // -------------------------------------------------------------------------
  // antibody_forget

  const forget = define(
    "antibody_forget",
    "Remove a misjudged entry from the fleet's shared antibody memory. It moves to ANTIBODIES.archive.md with the reason noted; nothing is deleted. Agents waiting for its fix stop waiting.",
    false,
    {
      id: { type: "string" },
      reason: { type: "string", description: "Why, kept in the archive." },
    },
    ["id"],
    async (args, memory) => {
      const id = given(args.id);
      if (id === undefined) throw new ToolError("id is empty");
      const found = byId(indexEntries(await memory.entries()), id);
      if (found === undefined)
        throw new ToolError(`no entry ${canonicalId(id)}`);
      const reason = given(args.reason);
      const archived = await memory.store.archive(found.entry.id, reason);
      if (archived === undefined)
        throw new ToolError(`no entry ${found.entry.id}`);
      await memory.log({
        kind: "forget",
        id: archived.id,
        ...(reason === undefined ? {} : { text: reason }),
      });
      if (await memory.claims.release(archived.fingerprint))
        await memory.log({
          kind: "release",
          id: archived.id,
          text: "forgotten",
        });
      return `Archived ${archived.id} to ANTIBODIES.archive.md.`;
    },
  );

  // -------------------------------------------------------------------------
  // antibody_stats

  const stats = define(
    "antibody_stats",
    "Show the fleet's antibody ledger: entries, hits, notices delivered, an estimate of tokens saved, open entries without a fix, which errors agents are diagnosing right now, distrusted fixes and the memory path. Costs no model call.",
    true,
    {
      scope: {
        type: "string",
        enum: STATS_SCOPES,
        description:
          "Count the notices of the whole fleet or of this agent only (default fleet). Entry figures are always the whole memory.",
      },
    },
    [],
    async (args, memory) => {
      const scope =
        (args.scope as (typeof STATS_SCOPES)[number] | undefined) ?? "fleet";
      const [entries, machine, live, log] = await Promise.all([
        memory.entries(),
        memory.machine(),
        memory.claims.read(),
        readEventsFrom(memory.files.events),
      ]);
      const now = clock.now();

      const events = log.events.filter(
        (e) => scope === "fleet" || e.agent === context.agent,
      );
      const notices = events.filter((e) => e.kind === "notice");
      const fixNotices = notices.filter((e) =>
        FIX_NOTICE_KINDS.includes(e.notice as NoticeKind),
      ).length;
      const noticeTokens = notices.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
      const net = fixNotices * ASSUMED_DIAGNOSIS_TOKENS - noticeTokens;
      const agents = new Set(events.map((e) => e.agent)).size;

      const level = (entry: Entry): TrustLevel => {
        const trust = machine.trust[entry.id];
        return trust?.fixSig === fixSig(entry.fix)
          ? trustLevel(trust)
          : "trusted";
      };
      const withFix = entries.filter((e) => oneLine(e.fix) !== "");
      const ids = (list: Entry[]) =>
        list.length === 0 ? "none" : list.map((e) => e.id).join(", ");

      const diagnosing = Object.values(live.claims)
        .filter((c) => activeClaim(live, c.id, now) !== undefined)
        .map((c) => {
          const entry = entries.find((e) => e.fingerprint === c.id);
          const since = elapsedText(now.getTime() - Date.parse(c.since));
          return `${entry?.id ?? `new error ${c.id}`} by ${c.agent} (${since})`;
        });

      const where = scope === "fleet" ? "the fleet" : context.agent;
      return [
        `Memory: ${memory.dir}`,
        `Entries: ${entries.length} · hits: ${entries.reduce((sum, e) => sum + e.hits, 0)} · open without a fix: ${entries.filter((e) => e.status === "open" && oneLine(e.fix) === "").length}`,
        `Notices (${where}): ${notices.length}, ${fixNotices} with a fix, ${noticeTokens} tokens${scope === "fleet" ? `, across ${agents} ${agents === 1 ? "agent" : "agents"}` : ""}`,
        `Estimated tokens saved: ${Math.max(0, net)} (estimate: ${fixNotices} fix ${fixNotices === 1 ? "notice" : "notices"} × ${ASSUMED_DIAGNOSIS_TOKENS} − ${noticeTokens} notice tokens${net < 0 ? ` = −${-net}, shown as 0` : ""})`,
        `Being diagnosed: ${diagnosing.length === 0 ? "none" : diagnosing.join(", ")}`,
        `Doubted fixes, injected with a warning: ${ids(withFix.filter((e) => level(e) === "doubted"))}`,
        `Distrusted fixes, not injected: ${ids(withFix.filter((e) => level(e) === "suppressed"))}`,
      ].join("\n");
    },
  );

  return [lookup, list, record, forget, stats];
}
