import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureInput } from "../src/capture";
import { createFleet } from "../src/fleet";
import { NotInGitRepoError, filesIn } from "../src/paths";
import type { ToolCall } from "../src/resolve-detect";
import { signature } from "../src/signature";
import { createStore } from "../src/store";
import type { StoreClock } from "../src/store";
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
