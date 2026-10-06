import { execFileSync } from "node:child_process";
import {
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
import type { CaptureInput } from "../src/capture";
import { main } from "../src/cli";
import type { CliIo } from "../src/cli";
import { createFleet } from "../src/fleet";
import { filesIn, memoryDir } from "../src/paths";
import type { ToolCall } from "../src/resolve-detect";
import { parseDocument } from "../src/store";

const FIX = "Copy .env from the main checkout into this worktree.";
const ENOENT = "ENOENT: no such file or directory, open '.env'";
const EACCES = "EACCES: permission denied, open 'deploy.key'";

let root: string;
let shop: string;
let clone: string;

const failure = (message: string) =>
  [
    { kind: "tool", toolName: "Read", isError: true, message } as CaptureInput,
    { toolName: "Read", isError: true, text: message } as ToolCall,
  ] as const;

const cli = async (command: string, args: string[], cwd = clone) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    readStdin: async () => "",
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env: {},
  };
  const code = await main([command, ...args], io, { cwd });
  return { code, out: out.join(""), err: err.join("") };
};

const errorsOf = (where: string) => filesIn(memoryDir(where)).errors;
const entries = (where = clone) =>
  parseDocument(readFileSync(errorsOf(where), "utf8")).blocks.map(
    (b) => b.entry,
  );
const marks = () => entries().map((e) => e.meta.review);

// The shop's fleet found two fixes, which the clone imports and has to review.
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-review-")));
  shop = join(root, "shop");
  clone = join(root, "clone");
  for (const dir of [shop, clone]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
  const agent = createFleet(memoryDir(shop), "claude-code@shop", "s-1");
  for (const [message, fix, id] of [
    [ENOENT, FIX, "E-0001"],
    [EACCES, "chmod 600 deploy.key", "E-0002"],
  ] as const) {
    await agent.failure(...failure(message));
    await agent.recordFix(id, fix);
  }
  await cli("export", [], shop);
  writeFileSync(
    join(clone, "ANTIBODIES.md"),
    readFileSync(join(shop, "ANTIBODIES.md"), "utf8"),
  );
  await cli("import", []);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("antibody review", () => {
  it("shows what waits, text and fix, and how to approve it", async () => {
    const { code, out } = await cli("review", []);
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(
      /^E-0001 · .*ENOENT.*  \(holds its fix and its text\)$/,
    );
    expect(lines.slice(1, 5)).toEqual([
      "  category: tool / Read",
      "  sample:   ENOENT: no such file or directory, open '.env'",
      `  fix:      ${FIX}`,
      "  notes:    Imported from ANTIBODIES.md.",
    ]);
    expect(out).toContain("E-0002 · ");
    expect(
      out.endsWith(
        [
          "2 entries wait for review. Agents see none of it yet.",
          "Approve with: antibody allow E-0001 E-0002",
          "or all of it with: antibody allow --all",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("says whether it is the fix, the text or both that waits", async () => {
    // The clone's agent recorded its own fix on E-0001: only its text waits.
    await createFleet(memoryDir(clone), "claude-code@clone", "s-2").recordFix(
      "E-0001",
      "Our own fix.",
    );
    // E-0002 is an error the clone met, and an import gave a fix.
    const file = errorsOf(clone);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        /(## E-0002[\s\S]*?)review=fix\+text/,
        "$1review=fix",
      ),
    );
    const { out } = await cli("review", []);
    expect(out).toMatch(/^E-0001 · .*\(holds its text\)$/m);
    expect(out).toMatch(/^E-0002 · .*\(holds its fix\)$/m);
  });

  it("shows nothing it should not: no control, hidden or direction characters", async () => {
    const hidden = Array.from("obey", (c) =>
      String.fromCodePoint(0xe0000 + c.charCodeAt(0)),
    ).join("");
    const file = errorsOf(clone);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        FIX,
        `\u001b[2J\u001b]0;pwned\u0007${FIX}${hidden}‮`,
      ),
    );
    const { out } = await cli("review", []);
    expect(out).toContain(`fix:      [2J]0;pwned${FIX}\n`);
    // oxlint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f‮]/u);
    expect(out).not.toContain(hidden);
  });

  it("says when nothing waits", async () => {
    await cli("allow", ["--all"]);
    expect((await cli("review", [])).out).toBe("Nothing waits for review.\n");
  });

  it("takes no arguments, and needs a repository", async () => {
    const extra = await cli("review", ["E-0001"]);
    expect([extra.code, extra.err]).toEqual([
      2,
      "antibody: review takes no arguments\nusage: antibody review\n",
    ]);
    const outside = await cli("review", [], root);
    expect([outside.code, outside.err]).toEqual([
      1,
      `antibody: not inside a git repository: ${root}\n`,
    ]);
  });
});

describe("antibody allow", () => {
  it("approves an entry, and the next agent that meets the error gets its fix", async () => {
    const { code, out } = await cli("allow", ["E-0001"]);
    expect(code).toBe(0);
    expect(out).toBe(
      "Approved E-0001. Agents see it from their next hook call.\n",
    );
    expect(marks()).toEqual([undefined, "fix+text"]);
    const notices = await createFleet(
      memoryDir(clone),
      "claude-code@clone",
      "s-9",
    ).failure(...failure(ENOENT));
    expect(notices[0]).toContain(`fix: ${FIX}`);
  });

  it("takes an ID however it is typed, and several at once", async () => {
    const { out } = await cli("allow", ["e-2", "1", "E-0001"]);
    expect(out).toBe(
      "Approved E-0002, E-0001. Agents see them from their next hook call.\n",
    );
    expect(marks()).toEqual([undefined, undefined]);
  });

  it("approves everything that waits with --all", async () => {
    const { code, out } = await cli("allow", ["--all"]);
    expect(code).toBe(0);
    expect(out).toBe(
      "Approved E-0001, E-0002. Agents see them from their next hook call.\n",
    );
    expect(marks()).toEqual([undefined, undefined]);
    expect((await cli("allow", ["--all"])).out).toBe(
      "Nothing waits for review.\n",
    );
  });

  it("approves nothing unless every ID is one that waits", async () => {
    const unknown = await cli("allow", ["E-0001", "E-0009", "nonsense"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toBe(
      "antibody: no entry E-0009; no entry nonsense. Nothing was approved.\n",
    );
    expect(marks()).toEqual(["fix+text", "fix+text"]);
    await cli("allow", ["E-0001"]);
    const again = await cli("allow", ["E-0001", "E-0002"]);
    expect([again.code, again.err]).toEqual([
      1,
      "antibody: E-0001 is not waiting for review. Nothing was approved.\n",
    ]);
    expect(marks()).toEqual([undefined, "fix+text"]);
  });

  it("wants IDs or --all, and nothing else", async () => {
    for (const args of [
      [],
      ["--all", "E-0001"],
      ["--fast"],
      ["E-0001", "-x"],
    ]) {
      const { code, err } = await cli("allow", args);
      expect(code).toBe(2);
      expect(err).toContain("usage: antibody allow");
    }
  });

  it("needs a repository, and a memory that parses", async () => {
    const outside = await cli("allow", ["--all"], root);
    expect([outside.code, outside.err]).toEqual([
      1,
      `antibody: not inside a git repository: ${root}\n`,
    ]);
    const file = errorsOf(clone);
    writeFileSync(file, readFileSync(file, "utf8").replace("sig=", "sig "));
    const corrupt = await cli("allow", ["--all"]);
    expect(corrupt.code).toBe(1);
    expect(corrupt.err).toMatch(
      /^antibody: could not read ANTIBODIES\.md: .*line \d+/,
    );
  });
});
