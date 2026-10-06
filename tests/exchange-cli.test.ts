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
import { parseDocument } from "../src/store";

// Built in two parts so this file holds no credential-shaped literal.
const SECRET = ["ghp_", "Zq7Xw2Lp9Rt4Vb8Nm3Kd6Hs1"].join("");
const FIX = "Copy .env from the main checkout into this worktree.";

let root: string;
let repo: string;

const failure = (message: string) =>
  [
    { kind: "tool", toolName: "Read", isError: true, message } as CaptureInput,
    { toolName: "Read", isError: true, text: message } as ToolCall,
  ] as const;

/** An agent meets an error, and, given a fix, records it. */
async function meet(message: string, fix?: string) {
  const fleet = createFleet(memoryDir(repo), "claude-code@shop", "s-1");
  await fleet.failure(...failure(message));
  if (fix !== undefined) {
    const id = (
      parseDocument(
        readFileSync(filesIn(memoryDir(repo)).errors, "utf8"),
      ).blocks.at(-1)?.entry as { id: string }
    ).id;
    await fleet.recordFix(id, fix);
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-export-")));
  repo = join(root, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = async (args: string[], cwd = repo) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    readStdin: async () => "",
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env: {},
  };
  const code = await main(["export", ...args], io, { cwd });
  return { code, out: out.join(""), err: err.join("") };
};

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
