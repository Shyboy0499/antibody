import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaptureInput } from "../src/capture";
import { main } from "../src/cli";
import type { CliIo } from "../src/cli";
import { appendEvent } from "../src/events";
import { createFleet } from "../src/fleet";
import { filesIn, injectionPaused, memoryDir } from "../src/paths";
import type { ToolCall } from "../src/resolve-detect";
import { memoryReader, runWatch } from "../src/watch";
import type { WatchDeps } from "../src/watch";

const SGR = /\u001b\[[0-9;]*m/;
const MESSAGE = "ENOENT: no such file or directory, open '.env'";
const capture: CaptureInput = {
  kind: "tool",
  toolName: "Read",
  isError: true,
  message: MESSAGE,
};
const call: ToolCall = { toolName: "Read", isError: true, text: MESSAGE };

let root: string;
let repo: string;
let wtA: string;
let wtB: string;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-watch-")));
  repo = join(root, "shop");
  wtA = join(root, "wt-a");
  wtB = join(root, "wt-b");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      { cwd: repo, stdio: "ignore" },
    );
  execFileSync("mkdir", ["-p", repo]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("worktree", "add", "-q", "-b", "a", wtA);
  git("worktree", "add", "-q", "-b", "b", wtB);
  // claude-code@wt-a claims a new error; gemini@wt-b holds on it.
  const memory = memoryDir(wtA);
  await createFleet(memory, "claude-code@wt-a", "s-a").failure(capture, call);
  await createFleet(memory, "gemini@wt-b", "s-b").failure(capture, call);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const io = (env: NodeJS.ProcessEnv = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = {
    readStdin: async () => "",
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env,
  };
  return { cli, out, err };
};
const size = { columns: 100, rows: 30 };

describe("antibody watch --once", () => {
  it("prints one plain frame of the fleet", async () => {
    const { cli, out } = io();
    const code = await main(["watch", "--once"], cli, {
      cwd: wtB,
      size: () => size,
    });
    expect(code).toBe(0);
    const lines = out.join("").split("\n");
    expect(lines).toHaveLength(31);
    expect(lines[0]).toMatch(/^ antibody  wt-b +2 agents · 1 diagnosing/);
    const text = lines.join("\n");
    expect(text).toMatch(/claude-code@wt-a +◐ diagnosing +E-0001/);
    expect(text).toMatch(
      /gemini@wt-b +◌ holding +E-0001 · claude-code@wt-a is on it/,
    );
    expect(text).toMatch(/E-0001 +ENOENT: no such file/);
    expect(text).not.toMatch(SGR);
  });

  it("fails outside a repository, and refuses unknown options", async () => {
    const outside = io();
    expect(await runWatch([], outside.cli, { cwd: root })).toBe(1);
    expect(outside.err.join("")).toBe(
      `antibody: not inside a git repository: ${root}\n`,
    );
    const bad = io();
    expect(await runWatch(["--fast"], bad.cli, { cwd: wtA })).toBe(2);
    expect(bad.err.join("")).toContain("usage: antibody watch");
  });
});

describe("antibody watch", () => {
  const watch = (deps: Partial<WatchDeps>, env: NodeJS.ProcessEnv = {}) => {
    const keys = new PassThrough();
    const { cli, out } = io(env);
    const done = runWatch([], cli, {
      cwd: wtA,
      size: () => size,
      intervalMs: 5,
      keys,
      ...deps,
    });
    return { keys, out, done };
  };
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 400 && !test(); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(test()).toBe(true);
  };

  it("draws on the alternate screen, follows the memory, and quits on q", async () => {
    const { keys, out, done } = watch({});
    await until(() => out.length > 2);
    expect(out[0]).toBe("\u001b[?1049h\u001b[?25l");
    expect(out[1]?.startsWith("\u001b[2J\u001b[H")).toBe(true);
    expect(out[1]).toMatch(SGR);
    // A new agent appears on the next redraw.
    await appendEvent(filesIn(memoryDir(wtA)).events, {
      kind: "hit",
      agent: "codex@wt-c",
      session: "s-c",
      id: "E-0001",
    });
    await until(() => (out.at(-1) ?? "").includes("codex@wt-c"));
    expect(out.at(-1)?.startsWith("\u001b[H")).toBe(true);
    keys.write("q");
    expect(await done).toBe(0);
    expect(out.at(-1)).toBe("\u001b[?25h\u001b[?1049l");
  });

  it("freezes and resumes on space, quits on Ctrl-C, and honours NO_COLOR", async () => {
    const { keys, out, done } = watch({}, { NO_COLOR: "1" });
    await until(() => out.length > 1);
    keys.write(" ");
    await until(() => out.some((o) => o.includes("frozen")));
    keys.write(" ");
    keys.write("x");
    keys.write("\u0003");
    expect(await done).toBe(0);
    expect(out.join("")).not.toMatch(SGR);
  });

  it("pauses injection for the fleet on p, and resumes it", async () => {
    const memory = memoryDir(wtA);
    const { keys, out, done } = watch({});
    await until(() => out.length > 1);
    keys.write("p");
    await until(() => out.some((o) => o.includes("injection paused")));
    expect(injectionPaused(memory)).toBe(true);
    keys.write("p");
    await until(() => !injectionPaused(memory));
    keys.write("q");
    await done;
  });

  it("clears the screen when the terminal changes size", async () => {
    let columns = 100;
    const { keys, out, done } = watch({ size: () => ({ columns, rows: 30 }) });
    await until(() => out.length > 2);
    columns = 120;
    const before = out.length;
    await until(() => out.slice(before).some((o) => o.startsWith("\u001b[2J")));
    keys.write("q");
    await done;
  });
});

describe("memoryReader", () => {
  it("reads new events only, and starts again when the log shrinks", async () => {
    const memory = memoryDir(wtA);
    const read = memoryReader(memory);
    const first = await read();
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.entries.map((e) => e.id)).toEqual(["E-0001"]);
    expect((await read()).events).toHaveLength(first.events.length);
    writeFileSync(filesIn(memory).events, "");
    expect((await read()).events).toEqual([]);
  });

  it("reads an unparseable ANTIBODIES.md as no entries", async () => {
    const dir = join(root, "corrupt");
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(
      join(dir, "ANTIBODIES.md"),
      "## E-0001 · x\n<!-- antibody: a -->\n",
    );
    expect((await memoryReader(dir)()).entries).toEqual([]);
  });
});
