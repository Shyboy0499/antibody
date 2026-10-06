// A fresh clone's first session takes in the committed ANTIBODIES.md, held
// for review, once; and the hook tells the agent that a person must review it.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_IMPORT_MARKER,
  autoImportText,
  importOnFirstSession,
} from "../src/auto-import";
import type { CaptureInput } from "../src/capture";
import { main, runHook } from "../src/cli";
import type { CliIo } from "../src/cli";
import { createFleet } from "../src/fleet";
import { filesIn, memoryDir, setInjectionPaused } from "../src/paths";
import type { ToolCall } from "../src/resolve-detect";
import { withinCaps } from "../src/notice";
import { nodeStoreFs, parseDocument } from "../src/store";

let root: string;
let shop: string;
let clone: string;

const failure = (message: string) =>
  [
    { kind: "tool", toolName: "Read", isError: true, message } as CaptureInput,
    { toolName: "Read", isError: true, text: message } as ToolCall,
  ] as const;

const io = (
  env: NodeJS.ProcessEnv = {},
  stdin = "",
): CliIo & { out: string } => {
  const sink = {
    out: "",
    readStdin: async () => stdin,
    stdout: (t: string) => void (sink.out += t),
    stderr: () => undefined,
    env,
  };
  return sink;
};

const entries = (repo: string) => {
  const file = filesIn(memoryDir(repo)).errors;
  return existsSync(file)
    ? parseDocument(readFileSync(file, "utf8")).blocks.map((b) => b.entry)
    : [];
};

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-auto-")));
  shop = join(root, "shop");
  clone = join(root, "clone");
  for (const dir of [shop, clone]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
  // The shop's fleet found two fixes and exported them; the clone has the file.
  const fleet = createFleet(memoryDir(shop), "claude-code@shop", "s-1");
  await fleet.failure(
    ...failure("ENOENT: no such file or directory, open '.env'"),
  );
  await fleet.recordFix("E-0001", "Copy .env from the main checkout.");
  await fleet.failure(
    ...failure("EACCES: permission denied, open 'deploy.key'"),
  );
  await fleet.recordFix("E-0002", "chmod 600 deploy.key");
  await main(["export"], io(), { cwd: shop });
  writeFileSync(
    join(clone, "ANTIBODIES.md"),
    readFileSync(join(shop, "ANTIBODIES.md"), "utf8"),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const first = (env: NodeJS.ProcessEnv = {}) =>
  importOnFirstSession(memoryDir(clone), clone, env);

describe("importOnFirstSession", () => {
  it("takes the committed fixes into a fresh clone's memory, held for review", async () => {
    expect(await first()).toBe(2);
    expect(entries(clone).map((e) => [e.fix, e.meta.review])).toEqual([
      ["Copy .env from the main checkout.", "fix+text"],
      ["chmod 600 deploy.key", "fix+text"],
    ]);
  });

  it("does it once per clone", async () => {
    await first();
    expect(await first()).toBeUndefined();
    expect(entries(clone)).toHaveLength(2);
  });

  it("imports once when two sessions start together", async () => {
    const counts = await Promise.all([first(), first(), first()]);
    expect(counts.filter((n) => n !== undefined)).toEqual([2]);
    expect(entries(clone)).toHaveLength(2);
  });

  it("leaves a memory that already has entries alone", async () => {
    const fleet = createFleet(memoryDir(clone), "claude-code@clone", "s-2");
    await fleet.failure(...failure("TypeError: x is not a function"));
    expect(await first()).toBeUndefined();
    expect(entries(clone)).toHaveLength(1);
  });

  it("does nothing without a committed export, and writes nothing", async () => {
    rmSync(join(clone, "ANTIBODIES.md"));
    expect(await first()).toBeUndefined();
    expect(existsSync(memoryDir(clone))).toBe(false);
  });

  it("does nothing when turned off", async () => {
    expect(await first({ ANTIBODY_AUTO_IMPORT: "0" })).toBeUndefined();
    expect(entries(clone)).toEqual([]);
  });

  it("takes in nothing from a file it cannot read, and does not try again", async () => {
    writeFileSync(
      join(clone, "ANTIBODIES.md"),
      "# not an export\n\n## E-1 x\n",
    );
    expect(await first()).toBeUndefined();
    expect(existsSync(join(memoryDir(clone), AUTO_IMPORT_MARKER))).toBe(true);
    expect(entries(clone)).toEqual([]);
  });

  it("says nothing when the file holds nothing to import", async () => {
    writeFileSync(
      join(clone, "ANTIBODIES.md"),
      readFileSync(join(shop, "ANTIBODIES.md"), "utf8").replace(
        /\n## [\s\S]*$/,
        "\n",
      ),
    );
    expect(await first()).toBeUndefined();
  });

  it("gives up when the file goes away under it", async () => {
    const fs = { ...nodeStoreFs(), readFile: async () => undefined };
    expect(
      await importOnFirstSession(memoryDir(clone), clone, {}, fs),
    ).toBeUndefined();
  });
});

describe("the session start hook", () => {
  const start = (env: NodeJS.ProcessEnv = {}) => {
    const sink = io(
      env,
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "s-1",
        cwd: clone,
        source: "startup",
      }),
    );
    return runHook("claude-code", sink).then(() => sink.out);
  };

  it("imports, and tells the agent a person must review it", async () => {
    const out = JSON.parse(await start());
    expect(out.hookSpecificOutput.additionalContext).toBe(autoImportText(2));
    expect(entries(clone)).toHaveLength(2);
    // The next session says nothing more.
    expect(await start()).toBe("");
  });

  it("imports without a word while injection is paused", async () => {
    mkdirSync(memoryDir(clone), { recursive: true });
    setInjectionPaused(memoryDir(clone), true);
    expect(await start()).toBe("");
    expect(entries(clone)).toHaveLength(2);
  });

  it("does nothing when turned off", async () => {
    expect(await start({ ANTIBODY_AUTO_IMPORT: "0" })).toBe("");
    expect(entries(clone)).toEqual([]);
  });
});

describe("autoImportText", () => {
  it("stays inside the notice caps", () => {
    expect(withinCaps(autoImportText(999_999))).toBe(true);
  });

  it("counts the fixes, and names what to run", () => {
    expect(autoImportText(1)).toBe(
      "[antibody] This clone took in 1 fix from the committed ANTIBODIES.md. No agent is shown it until a person reviews it: `antibody review`, then `antibody allow`.",
    );
    expect(autoImportText(3)).toContain(
      "took in 3 fixes from the committed ANTIBODIES.md. No agent is shown them until a person reviews them",
    );
  });
});
