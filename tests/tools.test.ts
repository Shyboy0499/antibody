import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureInput } from "../src/capture";
import { createClaimsFile, parseClaims } from "../src/claims";
import { readEventsFrom } from "../src/events";
import { createFleet } from "../src/fleet";
import { NotInGitRepoError, filesIn } from "../src/paths";
import type { ToolCall } from "../src/resolve-detect";
import { signature } from "../src/signature";
import { createStore, nodeStoreFs, parseDocument } from "../src/store";
import type { StoreClock, StoreFs } from "../src/store";
import { checkArgs, createTools } from "../src/tools";
import type { InputSchema, Tool, ToolsContext } from "../src/tools";

const MESSAGE = "ENOENT: no such file or directory, open '.env'";
const capture: CaptureInput = {
  kind: "tool",
  toolName: "Read",
  isError: true,
  message: MESSAGE,
};
const call: ToolCall = { toolName: "Read", isError: true, text: MESSAGE };
const FIX = "Copy .env from the main checkout into this worktree.";

let memory: string;
let now: Date;
const clock: StoreClock = {
  now: () => now,
  sleep: async (ms) => {
    now = new Date(now.getTime() + ms);
  },
  random: () => 0.5,
};

const tools = (context: Partial<ToolsContext> = {}) =>
  createTools({
    memory: () => memory,
    agent: "claude-code@wt-b",
    session: "mcp-1",
    deps: { clock },
    ...context,
  });
const tool = (name: string, context: Partial<ToolsContext> = {}) =>
  tools(context).find((t) => t.name === name) as Tool;
const run = (name: string, args?: unknown) => tool(name).call(args);
const text = async (name: string, args?: unknown) => {
  const result = await run(name, args);
  expect(result.isError).toBe(false);
  return result.text;
};

// The first agent meets the error; its hook appends E-0001 and claims it.
const fail = (session = "s-a") =>
  createFleet(memory, `claude-code@${session}`, session, {}, { clock }).failure(
    capture,
    call,
  );
const store = () => createStore(filesIn(memory), {}, undefined, clock);

beforeEach(async () => {
  memory = join(await mkdtemp(join(tmpdir(), "antibody-tools-")), "memory");
  now = new Date("2026-10-05T10:00:00Z");
});

afterEach(async () => {
  await rm(join(memory, ".."), { recursive: true, force: true });
});

describe("checkArgs", () => {
  const schema: InputSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      status: { type: "string", enum: ["open", "fixed"] },
      full: { type: "boolean" },
      limit: { type: "integer", minimum: 1 },
      offset: { type: "integer" },
    },
    required: ["name"],
    additionalProperties: false,
  };

  it("accepts arguments that fit", () => {
    expect(
      checkArgs(schema, {
        name: "x",
        status: "open",
        full: false,
        limit: 3,
        offset: -2,
      }),
    ).toBeUndefined();
  });

  it("names what does not fit", () => {
    expect(checkArgs(schema, [])).toBe("arguments must be an object");
    expect(checkArgs(schema, "name")).toBe("arguments must be an object");
    expect(checkArgs(schema, undefined)).toBe("name is required");
    expect(checkArgs(schema, { name: "x", extra: 1 })).toBe(
      "unknown argument extra",
    );
    expect(checkArgs(schema, { name: "x", constructor: 1 })).toBe(
      "unknown argument constructor",
    );
    expect(checkArgs(schema, { name: 1 })).toBe("name must be a string");
    expect(checkArgs(schema, { name: "x", status: "done" })).toBe(
      "status must be one of open, fixed",
    );
    expect(checkArgs(schema, { name: "x", full: "yes" })).toBe(
      "full must be true or false",
    );
    expect(checkArgs(schema, { name: "x", limit: 0 })).toBe(
      "limit must be an integer of at least 1",
    );
    expect(checkArgs(schema, { name: "x", limit: 1.5 })).toBe(
      "limit must be an integer of at least 1",
    );
    expect(checkArgs(schema, { name: "x", offset: "2" })).toBe(
      "offset must be an integer",
    );
  });
});

describe("tools", () => {
  it("describe their arguments with a closed JSON schema", () => {
    for (const t of tools()) {
      expect(t.name).toMatch(/^antibody_[a-z]+$/);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const key of t.inputSchema.required)
        expect(t.inputSchema.properties).toHaveProperty(key);
    }
  });

  it("refuse arguments that do not fit, naming the tool", async () => {
    expect(await run("antibody_lookup", { query: 7 })).toEqual({
      text: "antibody_lookup: query must be a string",
      isError: true,
    });
  });

  it("report a call from outside a repository", async () => {
    const result = await tool("antibody_lookup", {
      memory: () => {
        throw new NotInGitRepoError("/tmp/elsewhere");
      },
    }).call({ query: "E-0001" });
    expect(result).toEqual({
      text: "antibody_lookup: not inside a git repository: /tmp/elsewhere",
      isError: true,
    });
  });

  it("report a memory that does not parse", async () => {
    await fail();
    const file = filesIn(memory).errors;
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("sig=", "sig "),
    );
    const result = await run("antibody_lookup", { query: "E-0001" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /^antibody_lookup: could not read ANTIBODIES\.md: .*line \d+/,
    );
  });
});

describe("antibody_lookup", () => {
  it("finds an entry by ID, in any spelling", async () => {
    await fail();
    const found = await text("antibody_lookup", { query: "e-1" });
    expect(found.split("\n")).toEqual([
      expect.stringMatching(/^E-0001 · .*ENOENT/),
      "category: tool / Read · hits: 1 · status: open · matched by id",
      "fix: (none recorded)",
      "claude-code@s-a has been diagnosing this for 0 s; its fix will be recorded here.",
    ]);
  });

  it("says how long the diagnosis has run, and drops it with the claim", async () => {
    await fail();
    now = new Date(now.getTime() + 3 * 60_000);
    expect(await text("antibody_lookup", { query: "E-0001" })).toContain(
      "claude-code@s-a has been diagnosing this for 3 min;",
    );
    now = new Date(now.getTime() + 60 * 60_000);
    expect(await text("antibody_lookup", { query: "E-0001" })).not.toContain(
      "diagnosing",
    );
  });

  it("shows a recorded fix instead of the diagnosis", async () => {
    await fail();
    await store().update("E-0001", { fix: FIX, status: "fixed" });
    const found = await text("antibody_lookup", { query: "E-0001" });
    expect(found).toContain(`fix: ${FIX}`);
    expect(found).toContain("status: fixed");
    expect(found).not.toContain("diagnosing");
  });

  it("counts this machine's hits", async () => {
    await fail();
    await fail("s-b");
    expect(await text("antibody_lookup", { query: "E-0001" })).toContain(
      "hits: 2",
    );
  });

  it("finds an entry by fingerprint", async () => {
    await fail();
    const fingerprint = signature("tool", MESSAGE);
    expect(
      await text("antibody_lookup", { query: fingerprint.toUpperCase() }),
    ).toContain("matched by fingerprint");
  });

  it("finds an entry by its message, exactly or nearly", async () => {
    await fail();
    expect(
      await text("antibody_lookup", { query: `  ${MESSAGE}\n` }),
    ).toContain("matched by exact");
    expect(
      await text("antibody_lookup", {
        query: "ENOENT: no such file or directory, open '.env.local'",
      }),
    ).toMatch(/matched by (fuzzy|code)/);
  });

  it("prefers an exact match over a near one in another category", async () => {
    await fail();
    await store().append({
      title: "[command] ENOENT",
      signature: signature("command", "ENOENT: no such file or directory"),
      category: "command / bash",
      meta: { cat: "command", code: "ENOENT" },
      raw: "ENOENT: no such file or directory",
    });
    const found = await text("antibody_lookup", {
      query: "ENOENT: no such file or directory",
    });
    expect(found).toMatch(/^E-0002 /);
    expect(found).toContain("matched by exact");
  });

  it("returns the raw sample when asked", async () => {
    await fail();
    const found = await text("antibody_lookup", {
      query: "E-0001",
      full: true,
    });
    expect(found).toContain(`raw:\n${MESSAGE}`);
  });

  it("offers the closest entries on a miss", async () => {
    await fail();
    expect(
      await text("antibody_lookup", { query: "cannot open the file" }),
    ).toBe(
      "No entry matches \"cannot open the file\". Closest:\nE-0001 [tool:Read] ENOENT: no such file or directory, open '.env' (similarity 0.2)",
    );
  });

  it("says so when nothing is close", async () => {
    await fail();
    expect(await text("antibody_lookup", { query: "a8f3c1d2e4b5" })).toBe(
      'No entry matches "a8f3c1d2e4b5".',
    );
    expect(await text("antibody_lookup", { query: "kaboom" })).toBe(
      'No entry matches "kaboom".',
    );
  });

  it("refuses an unknown ID or a blank query", async () => {
    expect(await run("antibody_lookup", { query: "E-9" })).toEqual({
      text: "antibody_lookup: no entry E-0009 (it may have been archived)",
      isError: true,
    });
    expect(await run("antibody_lookup", { query: "  " })).toEqual({
      text: "antibody_lookup: query is empty",
      isError: true,
    });
  });
});

describe("antibody_list", () => {
  const seed = async (n: number) => {
    for (let i = 1; i <= n; i++)
      await store().append({
        title: `[command] npm test failed (${i})`,
        signature: signature("command", `npm test failed (${i})`),
        category: "command / Bash",
        meta: { cat: "command" },
        raw: `npm test failed (${i})`,
        ...(i % 2 === 0
          ? { fix: "Run pnpm install first.", status: "fixed" as const }
          : {}),
      });
  };

  it("lists entries with their hits and status", async () => {
    await fail();
    await fail("s-b");
    await seed(2);
    expect(await text("antibody_list")).toBe(
      [
        "E-0001 (2 hits, open) [tool:Read] ENOENT: no such file or directory, open '.env'",
        "E-0002 (1 hit, open) [command] npm test failed (1)",
        "E-0003 (1 hit, fixed) [command] npm test failed (2)",
        "3 of 3 shown.",
      ].join("\n"),
    );
  });

  it("filters by category, display category and status", async () => {
    await fail();
    await seed(2);
    const ids = async (args: object) =>
      (await text("antibody_list", args))
        .split("\n")
        .slice(0, -1)
        .map((line) => line.split(" ")[0]);
    expect(await ids({ cat: "Tool" })).toEqual(["E-0001"]);
    expect(await ids({ cat: "command / bash" })).toEqual(["E-0002", "E-0003"]);
    expect(await ids({ status: "fixed" })).toEqual(["E-0003"]);
    expect(await ids({ cat: "command", status: "open" })).toEqual(["E-0002"]);
  });

  it("stops at the limit, and at most at the maximum", async () => {
    await seed(3);
    expect(await text("antibody_list", { limit: 2 })).toMatch(
      /\n2 of 3 shown\.$/,
    );
    expect(await text("antibody_list", { limit: 10_000 })).toMatch(
      /\n3 of 3 shown\.$/,
    );
  });

  it("says so when nothing is listed", async () => {
    expect(await text("antibody_list", {})).toBe("No entries.");
    await seed(1);
    expect(await text("antibody_list", { status: "wontfix" })).toBe(
      "No entries.",
    );
  });

  it("refuses a limit below one", async () => {
    expect(await run("antibody_list", { limit: 0 })).toEqual({
      text: "antibody_list: limit must be an integer of at least 1",
      isError: true,
    });
  });
});

describe("antibody_record", () => {
  const entry = async (id = "E-0001") =>
    (await store().read()).blocks.find((b) => b.entry.id === id)?.entry;
  const events = async () =>
    (await readEventsFrom(filesIn(memory).events)).events.map((e) => [
      e.kind,
      e.agent,
      e.id,
    ]);
  const claims = async () =>
    parseClaims(await readFile(filesIn(memory).claims, "utf8"))?.claims;
  // ANTIBODIES.md as the tools read it: the real file for the reads `show`
  // allows, missing for the others.
  const flicker = (show: (read: number) => boolean): StoreFs => {
    const real = nodeStoreFs();
    let reads = 0;
    return {
      ...real,
      readFile: async (path) =>
        path === filesIn(memory).errors && !show(reads++)
          ? undefined
          : real.readFile(path),
    };
  };
  const recordWith = (fs: StoreFs, args: object) =>
    tool("antibody_record", { deps: { clock, fs } }).call(args);

  it("records a fix through the fleet, releasing the claim", async () => {
    await fail();
    expect(await text("antibody_record", { id: "E-1", fix: ` ${FIX} ` })).toBe(
      "Updated E-0001 (status fixed). Agents waiting for it get the fix at their next tool call.",
    );
    expect(await entry()).toMatchObject({ fix: FIX, status: "fixed" });
    expect(await claims()).toEqual({});
    expect((await events()).slice(-2)).toEqual([
      ["fix", "claude-code@wt-b", "E-0001"],
      ["release", "claude-code@wt-b", "E-0001"],
    ]);
  });

  it("hands the fix to an agent that was waiting for it", async () => {
    await fail();
    await fail("s-b");
    await text("antibody_record", { id: "E-0001", fix: FIX });
    const [notice] = await createFleet(
      memory,
      "claude-code@s-b",
      "s-b",
      {},
      { clock },
    ).poll();
    expect(notice).toContain(`fix: ${FIX}`);
  });

  it("changes status and adds notes, an explicit status winning", async () => {
    await fail();
    expect(
      await text("antibody_record", { id: "E-0001", note: "Seen on CI too." }),
    ).toBe("Updated E-0001 (status open). No fix recorded yet.");
    expect(
      await text("antibody_record", {
        id: "E-0001",
        fix: FIX,
        status: "wontfix",
        note: "Not ours to fix.",
      }),
    ).toBe("Updated E-0001 (status wontfix).");
    expect(await entry()).toMatchObject({
      fix: FIX,
      status: "wontfix",
      notes: "Seen on CI too.\nNot ours to fix.",
    });
    expect(
      await text("antibody_record", { id: "E-0001", status: "fixed" }),
    ).toBe("Updated E-0001 (status fixed).");
  });

  it("updates the entry a message matches exactly", async () => {
    await fail();
    expect(await text("antibody_record", { message: MESSAGE, fix: FIX })).toBe(
      "Updated E-0001 (status fixed). Agents waiting for it get the fix at their next tool call.",
    );
  });

  it("writes nothing on an approximate match", async () => {
    await fail();
    const result = await run("antibody_record", {
      message: "ENOENT: no such file or directory, open '.env.local'",
      fix: FIX,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /^antibody_record: closest match is E-0001 \(approximate, by (fuzzy|code)\); nothing was written\. Call antibody_record with id: "E-0001" to confirm, or reword message$/,
    );
    expect((await entry())?.fix).toBe("");
  });

  it("creates an entry for a new error, under agent by default", async () => {
    expect(
      await text("antibody_record", {
        message: "Error: listen EADDRINUSE: address already in use :::3000",
      }),
    ).toBe("Created E-0001 (status open). No fix recorded yet.");
    expect(await entry()).toMatchObject({
      title: "[agent] Error: listen EADDRINUSE: address already in use :::3000",
      category: "agent",
      status: "open",
      meta: expect.objectContaining({ cat: "agent", code: "EADDRINUSE" }),
    });
    expect(await events()).toEqual([["miss", "claude-code@wt-b", "E-0001"]]);
    expect(await claims()).toEqual({});
  });

  it("creates a fixed entry under the given category", async () => {
    expect(
      await text("antibody_record", {
        message: "pnpm: command not found",
        category: "command",
        fix: "Run corepack enable.",
        note: "Fresh containers only.",
      }),
    ).toBe(
      "Created E-0001 (status fixed). Agents waiting for it get the fix at their next tool call.",
    );
    expect(await entry()).toMatchObject({
      title: "[command] pnpm: command not found",
      fix: "Run corepack enable.",
      notes: "Fresh containers only.",
    });
    expect((await events()).map((e) => e[0])).toEqual(["miss", "fix"]);
    expect(
      await text("antibody_record", {
        message: "pnpm: command not found",
        category: "command",
        status: "wontfix",
      }),
    ).toBe("Updated E-0001 (status wontfix).");
  });

  it("leaves a new error to the agent already recording it", async () => {
    const message = "pnpm: command not found";
    await createClaimsFile(filesIn(memory), {}, undefined, clock).claim({
      id: signature("agent", message),
      agent: "codex@wt-c",
      session: "s-c",
    });
    expect(await run("antibody_record", { message })).toEqual({
      text: "antibody_record: codex@wt-c is recording this error right now; look it up with antibody_lookup in a moment",
      isError: true,
    });
  });

  it("uses an entry appended while it waited for the claim", async () => {
    // The hook of claude-code@s-a appends E-0001 and still holds its claim.
    await fail();
    expect(
      await recordWith(
        flicker((read) => read > 0),
        { message: MESSAGE, category: "tool", fix: FIX },
      ),
    ).toEqual({
      text: "Updated E-0001 (status fixed). Agents waiting for it get the fix at their next tool call.",
      isError: false,
    });
    expect(
      parseDocument(await readFile(filesIn(memory).errors, "utf8")).blocks,
    ).toHaveLength(1);
  });

  it("reports an entry that disappears under it", async () => {
    await fail();
    const gone = { text: "antibody_record: no entry E-0001", isError: true };
    expect(
      await recordWith(
        flicker((read) => read === 0),
        { id: "E-0001", fix: FIX },
      ),
    ).toEqual(gone);
    expect(
      await recordWith(
        flicker((read) => read === 0),
        {
          id: "E-0001",
          status: "fixed",
        },
      ),
    ).toEqual(gone);
    await rm(filesIn(memory).errors);
    expect(
      await recordWith(
        flicker((read) => read === 1),
        { message: MESSAGE },
      ),
    ).toEqual(gone);
  });

  it("says when the memory is busy", async () => {
    await fail();
    await writeFile(filesIn(memory).lock, "someone else");
    expect(
      await tool("antibody_record", {
        options: { lockTimeoutMs: 50 },
      }).call({ id: "E-0001", fix: FIX }),
    ).toEqual({
      text: "antibody_record: the memory is busy; try again",
      isError: true,
    });
  });

  it("refuses incomplete or contradictory arguments", async () => {
    await fail();
    const refused = async (args: object) =>
      (await run("antibody_record", args)).text;
    expect(await refused({})).toBe(
      "antibody_record: give exactly one of id and message",
    );
    expect(await refused({ id: "E-0001", message: MESSAGE })).toBe(
      "antibody_record: give exactly one of id and message",
    );
    expect(await refused({ id: "E-0001", fix: " " })).toBe(
      "antibody_record: fix is empty",
    );
    expect(await refused({ id: "E-0001", note: "" })).toBe(
      "antibody_record: nothing to record: give fix, status or note",
    );
    expect(await refused({ id: "E-0042", fix: FIX })).toBe(
      "antibody_record: no entry E-0042",
    );
    expect(await refused({ id: "latest", fix: FIX })).toBe(
      "antibody_record: no entry latest",
    );
  });
});
