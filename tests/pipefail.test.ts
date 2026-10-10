import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_PREFIX,
  PIPEFAIL_ENV,
  REWRITE_PREFIX,
  hasPipeline,
  needsRewrite,
  pipefailResponse,
  readStatus,
  rewriteCommand,
  statusPathFor,
  unwrapCommand,
} from "../src/pipefail";

// A shell to test the wrapper against: the rewrite is for a POSIX shell, and
// `bash` is the one Claude Code's Bash tool runs. A machine without a usable
// one (Windows, where `bash` on PATH may be a WSL without a distribution)
// skips the tests that run a command for real; the string tests still run.
const shellWorks = spawnSync("bash", ["-c", "exit 0"]).status === 0;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "antibody-pipefail-"));
  writeFileSync(join(dir, "package.json"), "{}");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run a wrapped command in bash, recording its status to a file. */
function runWrapped(command: string, file: string) {
  const wrapped = rewriteCommand(command, file, {}) as string;
  return spawnSync("bash", ["-c", wrapped], { encoding: "utf8", cwd: dir });
}

const payload = (command: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "probe" },
    tool_use_id: "toolu_test01",
    ...extra,
  });

describe("needsRewrite and hasPipeline", () => {
  it.each([
    ["npm test 2>&1 | tail -15", "a pipeline"],
    ["npm test; echo done", "a ; chain"],
    ["a && b", "an && chain"],
    ["a || b", "an || chain"],
    ["npm test &", "a background command"],
    ["npm test\n echo done", "a second line"],
  ])("wraps %s (%s)", (command) => {
    expect(needsRewrite(command)).toBe(true);
  });

  it.each([
    ["npm test", "one command"],
    ["npm test 2>&1", "a redirection's & is not a separator"],
    ["pnpm test -- --reporter=dot", "one command with flags"],
  ])("leaves %s alone (%s)", (command) => {
    expect(needsRewrite(command)).toBe(false);
  });

  it("tells a pipeline from a || and a redirection", () => {
    expect(hasPipeline("npm test 2>&1 | tail -15")).toBe(true);
    expect(hasPipeline("a || b")).toBe(false);
    expect(hasPipeline("npm test 2>&1")).toBe(false);
  });
});

describe("rewriteCommand", () => {
  it("wraps a compound command, and leaves a single one alone", () => {
    const file = join(dir, "x.status");
    const wrapped = rewriteCommand("npm test; echo done", file, {}) as string;
    expect(wrapped.startsWith(REWRITE_PREFIX)).toBe(true);
    expect(wrapped).toContain("npm test; echo done");
    expect(rewriteCommand("npm test", file, {})).toBeUndefined();
  });

  it("is idempotent: a command that already carries the wrapper is left alone", () => {
    const once = rewriteCommand("false; echo done", undefined, {}) as string;
    expect(rewriteCommand(once, undefined, {})).toBeUndefined();
  });

  it("is switched off by ANTIBODY_PIPEFAIL=0", () => {
    expect(
      rewriteCommand("a; b", undefined, { [PIPEFAIL_ENV]: "0" }),
    ).toBeUndefined();
  });
});

describe("unwrapCommand", () => {
  it.each([
    "npm test; echo done",
    "npm test 2>&1 | tail -15",
    "cat <<'EOF'\ntrap log\nEOF\nfalse; echo done",
  ])("gives back the command %j, with or without a status file", (command) => {
    const file = join(dir, "x.status");
    expect(unwrapCommand(rewriteCommand(command, file, {}) as string)).toBe(
      command,
    );
    expect(
      unwrapCommand(rewriteCommand(command, undefined, {}) as string),
    ).toBe(command);
  });

  it("takes off the earlier prefix too, so a command keeps its signature", () => {
    expect(unwrapCommand(`${LEGACY_PREFIX}npm test 2>&1 | tail -60`)).toBe(
      "npm test 2>&1 | tail -60",
    );
  });

  it("leaves a plain command alone", () => {
    expect(unwrapCommand("npm test")).toBe("npm test");
  });
});

describe("statusPathFor and readStatus", () => {
  it("names the file after the tool call, and refuses an unexpected id", () => {
    expect(statusPathFor("toolu_01abc")).toMatch(/toolu_01abc\.status$/);
    expect(statusPathFor("../escape")).toBeUndefined();
    expect(statusPathFor("")).toBeUndefined();
  });

  it("reads a recorded failure once, then removes the file", () => {
    const id = `test-${process.pid}-${Date.now()}`;
    const path = statusPathFor(id) as string;
    writeFileSync(path, "3", { flag: "w" });
    expect(readStatus(id)).toBe(3);
    expect(existsSync(path)).toBe(false);
    expect(readStatus(id)).toBeUndefined();
  });

  it("reads nothing from a record of success", () => {
    const id = `test-zero-${process.pid}-${Date.now()}`;
    const path = statusPathFor(id) as string;
    writeFileSync(path, "0", { flag: "w" });
    expect(readStatus(id)).toBeUndefined();
  });
});

describe("pipefailResponse", () => {
  it("answers a compound Bash command with the wrapped input", () => {
    const out = JSON.parse(
      pipefailResponse(payload("npm test; echo done"), {}),
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.updatedInput.command).toContain(
      "npm test; echo done",
    );
    expect(out.hookSpecificOutput.updatedInput.command).toContain(
      statusPathFor("toolu_test01"),
    );
    expect(out.hookSpecificOutput.updatedInput.description).toBe("probe");
  });

  it("says nothing for other tools, other events and unreadable payloads", () => {
    expect(
      pipefailResponse(payload("a; b").replace('"Bash"', '"Read"'), {}),
    ).toBe("");
    expect(
      pipefailResponse(
        payload("a; b").replace("PreToolUse", "PostToolUse"),
        {},
      ),
    ).toBe("");
    expect(pipefailResponse("{", {})).toBe("");
    expect(pipefailResponse("null", {})).toBe("");
    expect(pipefailResponse(payload("npm test"), {})).toBe("");
  });
});

describe("the wrapper in a real shell", () => {
  it.skipIf(!shellWorks)(
    "records a failure the status of the chain does not show",
    () => {
      const file = join(dir, "cat.status");
      const run = runWrapped("cat missing.txt; echo done", file);
      // The chain's status is the plain one: the trailing echo's.
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("done\n");
      expect(readFileSync(file, "utf8")).toBe("1");
    },
  );

  it.skipIf(!shellWorks)(
    "records a silent failure followed by a command that succeeds",
    () => {
      const file = join(dir, "silent.status");
      const run = runWrapped('node -e "process.exit(3)"; echo done', file);
      expect(run.status).toBe(0);
      expect(readFileSync(file, "utf8")).toBe("3");
    },
  );

  it.skipIf(!shellWorks)(
    "does not count a grep, diff or test that found nothing",
    () => {
      for (const command of [
        "grep -q zzz package.json; echo done",
        "echo a; grep -q zzz package.json",
        "diff <(echo a) <(echo b); echo done",
        "test -f no-such-file; echo done",
      ]) {
        const file = join(dir, `${command.length}.status`);
        const run = runWrapped(command, file);
        expect(run.status, command).toBe(0);
        expect(readFileSync(file, "utf8"), command).toBe("0");
      }
    },
  );

  it.skipIf(!shellWorks)(
    "keeps a real failure beside a grep that found nothing",
    () => {
      const file = join(dir, "beside.status");
      const run = runWrapped(
        "grep -q zzz package.json; false; echo done",
        file,
      );
      expect(run.status).toBe(0);
      expect(readFileSync(file, "utf8")).toBe("1");
      const last = runWrapped(
        "false; grep -q zzz package.json",
        join(dir, "b.status"),
      );
      expect(last.status).toBe(1);
    },
  );

  it.skipIf(!shellWorks)(
    "leaves the agent's own $? and a handled failure as they were",
    () => {
      const handled = runWrapped(
        "false || echo handled",
        join(dir, "h.status"),
      );
      expect(handled.status).toBe(0);
      expect(handled.stdout).toBe("handled\n");
      const reads = runWrapped('false; echo "rc=$?"', join(dir, "r.status"));
      expect(reads.status).toBe(0);
      expect(reads.stdout).toBe("rc=1\n");
    },
  );

  it.skipIf(!shellWorks)("keeps a heredoc's terminator intact", () => {
    const run = runWrapped(
      "cat <<'EOF'\nhi\nEOF\nfalse",
      join(dir, "hd.status"),
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("hi\n");
  });
});
