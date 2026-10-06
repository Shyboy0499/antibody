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
import type { CaptureInput } from "../src/capture";
import { main } from "../src/cli";
import type { CliIo } from "../src/cli";
import { createFleet } from "../src/fleet";
import { filesIn, memoryDir } from "../src/paths";
import type { ToolCall } from "../src/resolve-detect";
import { forAgents } from "../src/review";
import { parseDocument } from "../src/store";
import type { Block } from "../src/store";

// Built in two parts so this file holds no credential-shaped literal.
const SECRET = ["ghp_", "Zq7Xw2Lp9Rt4Vb8Nm3Kd6Hs1"].join("");
const FIX = "Copy .env from the main checkout into this worktree.";

let root: string;
let repo: string;
let clone: string;

const failure = (message: string) =>
  [
    { kind: "tool", toolName: "Read", isError: true, message } as CaptureInput,
    { toolName: "Read", isError: true, text: message } as ToolCall,
  ] as const;

/** An agent meets an error, and, given a fix, records it. */
async function meet(message: string, fix?: string, where = repo) {
  const fleet = createFleet(memoryDir(where), "claude-code@shop", "s-1");
  await fleet.failure(...failure(message));
  if (fix !== undefined) {
    const { blocks } = parseDocument(
      readFileSync(filesIn(memoryDir(where)).errors, "utf8"),
    );
    const id = (blocks[blocks.length - 1] as Block).entry.id;
    await fleet.recordFix(id, fix);
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-export-")));
  repo = join(root, "shop");
  clone = join(root, "clone");
  for (const dir of [repo, clone]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const cli = async (command: string, args: string[], cwd = repo) => {
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
const run = (args: string[], cwd = repo) => cli("export", args, cwd);

describe("antibody export", () => {
  it("writes the fixes this fleet found to ANTIBODIES.md in the repository root", async () => {
    await meet("ENOENT: no such file or directory, open '.env'", FIX);
    await meet("EACCES: permission denied, open 'deploy.key'");
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "Exported 1 of 2 entries to ANTIBODIES.md.",
        "1 left out: no fix yet, or a fix still waiting for review.",
        "Look it over, then commit it.",
        "",
      ].join("\n"),
    );
    const document = parseDocument(
      readFileSync(join(repo, "ANTIBODIES.md"), "utf8"),
    );
    expect(document.blocks.map((b) => b.entry.fix)).toEqual([FIX]);
  });

  it("redacts what was hand-edited into the memory since", async () => {
    await meet("ENOENT: no such file or directory, open '.env'", FIX);
    const errors = filesIn(memoryDir(repo)).errors;
    writeFileSync(
      errors,
      readFileSync(errors, "utf8").replace(FIX, `Use token ${SECRET}.`),
    );
    expect((await run(["--print"])).out).not.toContain(SECRET);
  });

  it("prints the document with --print, and writes no file", async () => {
    await meet("ENOENT: no such file or directory, open '.env'", FIX);
    const { code, out, err } = await run(["--print"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out.startsWith("# ANTIBODIES\n")).toBe(true);
    expect(out).toContain(FIX);
    expect(existsSync(join(repo, "ANTIBODIES.md"))).toBe(false);
  });

  it("writes where --out says, below the working directory", async () => {
    await meet("ENOENT: no such file or directory, open '.env'", FIX);
    const { code, out } = await run(["--out", "docs/fixes.md"]);
    expect(code).toBe(0);
    expect(out).toContain("to docs/fixes.md.");
    expect(readFileSync(join(repo, "docs", "fixes.md"), "utf8")).toContain(FIX);
    expect(existsSync(join(repo, "ANTIBODIES.md"))).toBe(false);
  });

  it("names a file outside the working directory in full", async () => {
    await meet("ENOENT: no such file or directory, open '.env'", FIX);
    const target = join(root, "elsewhere.md");
    expect((await run(["--out", target])).out).toContain(`to ${target}.`);
  });

  it("says when the file is already up to date, and leaves it alone", async () => {
    await meet("ENOENT: no such file or directory, open '.env'", FIX);
    await run([]);
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toBe("ANTIBODIES.md is up to date (1 entry).\n");
  });

  it("replaces an earlier export, but not a file that is something else", async () => {
    await meet("ENOENT: no such file or directory, open '.env'", FIX);
    await run([]);
    await meet("EACCES: permission denied, open 'deploy.key'", "chmod 600 it");
    expect((await run([])).out).toContain("Exported 2 of 2 entries");
    writeFileSync(join(repo, "NOTES.md"), "# My notes\n");
    const refused = await run(["--out", "NOTES.md"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(
      "antibody: NOTES.md exists and is not an antibody export; choose another file with --out\n",
    );
    expect(readFileSync(join(repo, "NOTES.md"), "utf8")).toBe("# My notes\n");
  });

  it("writes nothing when no entry has a fix", async () => {
    await meet("ENOENT: no such file or directory, open '.env'");
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toBe(
      "Nothing to export: no entry has a fix that was found in this repository yet.\n",
    );
    expect(existsSync(join(repo, "ANTIBODIES.md"))).toBe(false);
    // With --print stdout is the document's alone, so the note goes to stderr.
    const printed = await run(["--print"]);
    expect([printed.out, printed.err === ""]).toEqual(["", false]);
  });

  it("fails outside a repository, and on a memory it cannot read", async () => {
    const outside = await run([], root);
    expect(outside.code).toBe(1);
    expect(outside.err).toBe(
      `antibody: not inside a git repository: ${root}\n`,
    );
    await meet("ENOENT: no such file or directory, open '.env'", FIX);
    const errors = filesIn(memoryDir(repo)).errors;
    writeFileSync(errors, readFileSync(errors, "utf8").replace("sig=", "sig "));
    const corrupt = await run([]);
    expect(corrupt.code).toBe(1);
    expect(corrupt.err).toMatch(
      /^antibody: could not read ANTIBODIES\.md: .*line \d+/,
    );
  });

  it("refuses unknown options, and --out without a file or beside --print", async () => {
    for (const args of [["--fast"], ["--out"], ["--print", "--out", "x"]]) {
      const { code, err } = await run(args);
      expect(code).toBe(2);
      expect(err).toContain("usage: antibody export");
    }
  });
});

const ENOENT = "ENOENT: no such file or directory, open '.env'";
const EACCES = "EACCES: permission denied, open 'deploy.key'";

/** The entries in a clone's memory, as agents may not yet see them. */
const entriesOf = (where: string) =>
  parseDocument(
    readFileSync(filesIn(memoryDir(where)).errors, "utf8"),
  ).blocks.map((b) => b.entry);

describe("antibody import", () => {
  // The shop's fleet found two fixes; the file goes to the clone's root.
  beforeEach(async () => {
    await meet(ENOENT, FIX);
    await meet(EACCES, "chmod 600 deploy.key");
    await run([]);
    writeFileSync(
      join(clone, "ANTIBODIES.md"),
      readFileSync(join(repo, "ANTIBODIES.md"), "utf8"),
    );
  });

  const importing = (args: string[] = [], cwd = clone) =>
    cli("import", args, cwd);

  it("reads the file's fixes into a fresh clone, held for review", async () => {
    const { code, out } = await importing();
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "Imported 2 fixes from ANTIBODIES.md: 2 for new errors, 0 for errors this machine had no fix for.",
        "They wait for your review, and no agent sees them until you approve them.",
        "",
      ].join("\n"),
    );
    const entries = entriesOf(clone);
    expect(entries.map((e) => [e.fix, e.status, e.meta.review])).toEqual([
      [FIX, "fixed", "fix+text"],
      ["chmod 600 deploy.key", "fixed", "fix+text"],
    ]);
    expect(entries[0]?.notes).toBe("Imported from ANTIBODIES.md.");
    expect(entries[0]?.fingerprint).toBe(entriesOf(repo)[0]?.fingerprint);
  });

  it("shows no agent what it imported: the agent that meets the error diagnoses it", async () => {
    await importing();
    const notices = await createFleet(
      memoryDir(clone),
      "claude-code@clone",
      "s-9",
    ).failure(...failure(ENOENT));
    expect(notices).toEqual([
      "[antibody] E-0001 seen before (2 hits), no fix recorded yet.",
    ]);
    expect(forAgents(entriesOf(clone)[0] as Block["entry"])).toMatchObject({
      title: "",
      fix: "",
      status: "open",
    });
  });

  it("changes nothing when run again", async () => {
    await importing();
    const before = readFileSync(filesIn(memoryDir(clone)).errors, "utf8");
    const again = await importing();
    expect(again.out).toBe(
      "Nothing to import from ANTIBODIES.md (2 already known here).\n",
    );
    expect(readFileSync(filesIn(memoryDir(clone)).errors, "utf8")).toBe(before);
  });

  it("gives its fix to an error this machine met and could not solve", async () => {
    await meet(ENOENT, undefined, clone);
    const { out } = await importing();
    expect(out).toContain(
      "Imported 2 fixes from ANTIBODIES.md: 1 for new errors, 1 for errors this machine had no fix for.",
    );
    const [met, added] = entriesOf(clone);
    expect(met).toMatchObject({ fix: FIX, status: "fixed" });
    expect(met?.meta.review).toBe("fix");
    // The entry's own text stays visible: only the fix is held back.
    expect(met?.title).toContain("ENOENT");
    expect(added?.meta.review).toBe("fix+text");
    expect(forAgents(met as Block["entry"])).toMatchObject({
      fix: "",
      status: "open",
    });
  });

  it("says what it would do with --dry-run, and does it not", async () => {
    const { code, out } = await importing(["--dry-run"]);
    expect(code).toBe(0);
    expect(out).toBe(
      "Would import 2 fixes from ANTIBODIES.md: 2 for new errors, 0 for errors this machine had no fix for.\n",
    );
    expect(existsSync(filesIn(memoryDir(clone)).errors)).toBe(false);
  });

  it("reads the file it is given, below the working directory or not", async () => {
    const elsewhere = join(root, "shared.md");
    writeFileSync(elsewhere, readFileSync(join(repo, "ANTIBODIES.md"), "utf8"));
    expect((await importing([elsewhere])).out).toContain(
      `fixes from ${elsewhere}:`,
    );
  });

  it("says what it left out", async () => {
    const file = join(clone, "ANTIBODIES.md");
    const text = readFileSync(file, "utf8");
    const first = text.slice(
      text.indexOf("## E-0001"),
      text.indexOf("## E-0002"),
    );
    // The same error again, under another ID.
    writeFileSync(file, `${text}\n${first.replaceAll("E-0001", "E-0007")}`);
    const { code, out } = await importing();
    expect(code).toBe(0);
    expect(out).toContain("Imported 2 fixes");
    expect(out).toMatch(/\nLeft out: 1 repeated in the file\.\n$/);
  });

  it("refuses a file that is missing, too large, or not a document", async () => {
    const missing = await importing(["nope.md"]);
    expect([missing.code, missing.err]).toEqual([
      1,
      "antibody: no such file: nope.md\n",
    ]);
    writeFileSync(join(clone, "big.md"), "x".repeat(600 * 1024));
    const big = await importing(["big.md"]);
    expect([big.code, big.err]).toEqual([
      1,
      "antibody: big.md is larger than 512 KiB; not importing it\n",
    ]);
    writeFileSync(
      join(clone, "bad.md"),
      "## E-0001 · broken\n<!-- antibody: sig -->\n",
    );
    const bad = await importing(["bad.md"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^antibody: could not read bad\.md: .*line \d+/);
  });

  it("fails outside a repository, and on options it does not know", async () => {
    const outside = await importing([], root);
    expect([outside.code, outside.err]).toEqual([
      1,
      `antibody: not inside a git repository: ${root}\n`,
    ]);
    for (const args of [["--fast"], ["a.md", "b.md"]]) {
      const { code, err } = await importing(args);
      expect(code).toBe(2);
      expect(err).toContain("usage: antibody import");
    }
  });
});
