import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseClaims } from "../src/claims";
import { readEventsFrom } from "../src/events";
import { filesIn } from "../src/paths";
import { parseState } from "../src/state";
import { formatId, parseDocument } from "../src/store";

// The M1 acceptance test (docs/roadmap.md): eight writer processes hammering
// one memory directory lose no event and corrupt no file. Each writer is a
// real process (tests/fixtures/writer.ts, run through vite-node), so the only
// thing keeping them apart is the file lock, O_APPEND and atomic renames.
const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const viteNode = resolve(root, "node_modules", "vite-node", "vite-node.mjs");
const writer = resolve(root, "tests", "fixtures", "writer.ts");

const WRITERS = 8;
const ROUNDS = 5;
const agents = Array.from({ length: WRITERS }, (_, n) => `agent-${n + 1}`);

type Summary = { agent: string; granted: number };
type Outcome = PromiseSettledResult<{ stdout: string }>;

// Every writer runs to its end, even when one fails: the others keep writing
// into the directory, so the suite must not tear it down under them. A failed
// writer is reported once all of them have finished, not as soon as it fails.
const runWriters = (
  names: string[],
  memoryOf: (agent: string) => string,
): Promise<Outcome[]> =>
  Promise.allSettled(
    names.map((agent) =>
      run(process.execPath, [viteNode, writer], {
        cwd: root,
        env: {
          ...process.env,
          ANTIBODY_TEST_MEMORY: memoryOf(agent),
          ANTIBODY_TEST_AGENT: agent,
          ANTIBODY_TEST_ROUNDS: String(ROUNDS),
        },
      }),
    ),
  );

const summaryOf = ({ stdout }: { stdout: string }): Summary =>
  JSON.parse(stdout.trim().split("\n").at(-1)!);

let dir: string;
let summaries: Summary[];

beforeAll(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "antibody-eight-")), "memory");
  const outcomes = await runWriters(agents, () => dir);
  const failed = outcomes.filter((o) => o.status === "rejected");
  if (failed.length > 0)
    throw new Error(`${failed.length} writer(s) failed: ${failed[0]!.reason}`);
  summaries = outcomes.map((o) =>
    summaryOf((o as PromiseFulfilledResult<{ stdout: string }>).value),
  );
}, 120_000);

afterAll(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true });
});

describe("eight writer processes on one memory directory", () => {
  const files = () => filesIn(dir);

  it("every writer finished", () => {
    expect(summaries.map((s) => s.agent).sort()).toEqual([...agents].sort());
  });

  it("lose no event", async () => {
    const { events, skipped } = await readEventsFrom(files().events);
    expect(skipped).toBe(0);
    expect(events).toHaveLength(WRITERS * ROUNDS);
    for (const agent of agents)
      expect(events.filter((e) => e.agent === agent)).toHaveLength(ROUNDS);
  });

  it("number every entry once, with no gap", async () => {
    const document = parseDocument(await readFile(files().errors, "utf8"));
    const ids = document.blocks.map((b) => b.entry.id);
    expect(ids).toEqual(
      Array.from({ length: WRITERS * ROUNDS }, (_, n) => formatId(n + 1)),
    );
  });

  it("lose no hit-counter increment", async () => {
    const state = parseState(await readFile(files().state, "utf8"));
    expect(state?.entries["E-shared"]?.hits).toBe(WRITERS * ROUNDS);
  });

  it("leave claims.json readable, with every won claim released", async () => {
    const claims = parseClaims(await readFile(files().claims, "utf8"));
    expect(claims?.claims).toEqual({});
    expect(summaries.reduce((sum, s) => sum + s.granted, 0)).toBeGreaterThan(0);
  });

  it("leave no lock, temp file or corrupt copy behind", async () => {
    const names = await readdir(dir);
    expect(
      names.filter(
        (n) => n === ".lock" || n.endsWith(".tmp") || n.includes("corrupt"),
      ),
    ).toEqual([]);
  });
});

describe("a writer that fails to start", () => {
  // The crashed writer's memory is under a plain file, so its first write
  // fails with ENOTDIR. The other writers must still run to the end, and their
  // events must still land: tearing the directory down early would lose them.
  let root2: string;
  let outcomes: Outcome[];
  let memory: string;
  const names = ["steady-1", "steady-2", "crashed"];

  beforeAll(async () => {
    root2 = await mkdtemp(join(tmpdir(), "antibody-crash-"));
    memory = join(root2, "memory");
    await writeFile(join(root2, "blocker"), "a file, not a directory\n");
    const blocked = join(root2, "blocker", "memory");
    outcomes = await runWriters(names, (agent) =>
      agent === "crashed" ? blocked : memory,
    );
  }, 120_000);

  afterAll(async () => {
    await rm(root2, { recursive: true, force: true });
  });

  it("reports the crashed writer, after the others have finished", () => {
    expect(outcomes.map((o) => o.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
  });

  it("keeps every event the writers that did not crash appended", async () => {
    const { events } = await readEventsFrom(filesIn(memory).events);
    for (const agent of names.slice(0, 2))
      expect(events.filter((e) => e.agent === agent)).toHaveLength(ROUNDS);
  });
});
