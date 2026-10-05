#!/usr/bin/env node
// The M2 check, end to end, against the committed bundle (docs/roadmap.md):
// two Claude Code sessions in two worktrees of one repository hit the same
// missing-.env error, and the second receives the first one's fix within one
// second of it being recorded. Then it measures how long a hook call takes.
//
// It drives dist/antibody.mjs exactly as Claude Code does: one process per
// hook call with the payload on stdin, and `antibody mcp claude-code` as a
// stdio MCP server with CLAUDE_PROJECT_DIR and CLAUDE_CODE_SESSION_ID set. No
// model is involved; the agents' tool calls are scripted.
//
//   node scripts/e2e.mjs [--samples N]
//
// Exits 1 when the fix is not delivered, or not within a second. The hook
// latency target is reported, not enforced.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const BUNDLE = fileURLToPath(new URL("../dist/antibody.mjs", import.meta.url));
const DELIVERY_LIMIT_MS = 1000;
const LATENCY_TARGET_MS = 50;
const samplesArg = process.argv.indexOf("--samples");
const SAMPLES =
  samplesArg === -1 ? 20 : Math.max(1, Number(process.argv[samplesArg + 1]));

const root = realpathSync(mkdtempSync(join(tmpdir(), "antibody-e2e-")));
const repo = join(root, "repo");
const wt = (name) => join(root, name);
const git = (...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args],
    { cwd: repo, stdio: "ignore" },
  );

const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;

/** One hook call in its own process, as Claude Code makes it. */
function hook(event, cwd, session, fields = {}) {
  const payload = JSON.stringify({
    hook_event_name: event,
    session_id: session,
    cwd,
    transcript_path: join(root, `${session}.jsonl`),
    ...fields,
  });
  const start = process.hrtime.bigint();
  const out = execFileSync(process.execPath, [BUNDLE, "hook", "claude-code"], {
    input: payload,
  }).toString();
  const elapsed = ms(start);
  const context =
    out === "" ? "" : JSON.parse(out).hookSpecificOutput.additionalContext;
  return { context, ms: elapsed };
}

// The error a fresh worktree gives: the dev server cannot read its .env.
const missingEnv = (cwd, session) =>
  hook("PostToolUseFailure", cwd, session, {
    tool_name: "Bash",
    tool_input: { command: "pnpm dev" },
    error: `Exit code 1\nError: ENOENT: no such file or directory, open '${cwd}/.env'`,
  });
const otherCall = (cwd, session, n = 0) =>
  hook("PostToolUse", cwd, session, {
    tool_name: "Read",
    tool_input: { file_path: join(cwd, `src/file-${n}.ts`) },
    tool_response: "export {};",
  });

/** A stdio MCP client for one `antibody mcp claude-code` server. */
function mcpClient(cwd, session) {
  const child = spawn(process.execPath, [BUNDLE, "mcp", "claude-code"], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
      CLAUDE_CODE_SESSION_ID: session,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((done) => {
      const id = nextId++;
      waiting.set(id, done);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  return {
    async start() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    },
    async call(name, args) {
      const response = await request("tools/call", { name, arguments: args });
      return response.result.content[0].text;
    },
    stop: () =>
      new Promise((done) => {
        child.on("exit", done);
        child.stdin.end();
      }),
  };
}

const median = (list) => [...list].sort((a, b) => a - b)[list.length >> 1];
const p90 = (list) =>
  [...list].sort((a, b) => a - b)[Math.floor(list.length * 0.9)];
const fmt = (n) => `${n.toFixed(0)} ms`;

function check(ok, text) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${text}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

try {
  execFileSync("mkdir", ["-p", repo]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, ".env.example"), "DATABASE_URL=\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  for (const name of ["wt-a", "wt-b", "wt-c"])
    git("worktree", "add", "-q", "-b", name, wt(name));

  console.log("Delivery: two sessions, two worktrees, one error\n");
  for (const [name, session] of [
    ["wt-a", "s-a"],
    ["wt-b", "s-b"],
  ])
    hook("SessionStart", wt(name), session, { source: "startup" });

  const first = missingEnv(wt("wt-a"), "s-a");
  check(
    first.context === "",
    "claude-code@wt-a meets the error first and claims it, silently",
  );

  const second = missingEnv(wt("wt-b"), "s-b");
  check(
    second.context.includes("claude-code@wt-a has been diagnosing this"),
    `claude-code@wt-b is told a peer is on it: "${second.context}"`,
  );

  const mcp = mcpClient(wt("wt-a"), "s-a");
  await mcp.start();
  const id = /E-\d+/.exec(second.context)?.[0] ?? "E-0001";
  const fix = "Copy .env from the main checkout: cp ../repo/.env.example .env";
  const recorded = await mcp.call("antibody_record", { id, fix });
  const recordedAt = process.hrtime.bigint();
  await mcp.stop();
  check(
    recorded.startsWith(`Updated ${id} (status fixed)`),
    `claude-code@wt-a records the fix: "${recorded}"`,
  );

  const next = otherCall(wt("wt-b"), "s-b");
  const delivery = ms(recordedAt);
  check(
    next.context.includes(fix),
    `claude-code@wt-b's next tool call carries the fix: "${next.context}"`,
  );
  check(
    delivery < DELIVERY_LIMIT_MS,
    `delivered ${fmt(delivery)} after it was recorded (limit ${fmt(DELIVERY_LIMIT_MS)})`,
  );

  const later = missingEnv(wt("wt-c"), "s-c");
  check(
    later.context.includes("Known fix") && later.context.includes(fix),
    `a third agent meeting the error later gets the fix at once: "${later.context}"`,
  );

  console.log(`\nHook latency, ${SAMPLES} calls each, through the bundle\n`);
  const times = {
    "failure, new error": [],
    "failure, held": [],
    success: [],
    "outside a repository": [],
  };
  for (let n = 0; n < SAMPLES; n++) {
    const fail = (cwd, session) =>
      hook("PostToolUseFailure", cwd, session, {
        tool_name: "Bash",
        tool_input: { command: `pnpm test ${n}` },
        error: `Exit code 1\nError: Environment variable not found: VAR_${n}.`,
      });
    times["failure, new error"].push(fail(wt("wt-a"), "s-a").ms);
    times["failure, held"].push(fail(wt("wt-b"), "s-b").ms);
    times.success.push(otherCall(wt("wt-b"), "s-b", n).ms);
    times["outside a repository"].push(otherCall(root, "s-x", n).ms);
  }
  const bare = [];
  for (let n = 0; n < SAMPLES; n++) {
    const start = process.hrtime.bigint();
    execFileSync(process.execPath, ["-e", "0"]);
    bare.push(ms(start));
  }
  for (const [kind, list] of Object.entries(times))
    console.log(
      `${median(list) < LATENCY_TARGET_MS ? "ok  " : "slow"}  ${kind.padEnd(22)} median ${fmt(median(list)).padStart(6)}  p90 ${fmt(p90(list)).padStart(6)}`,
    );
  console.log(
    `      ${"node -e 0, for scale".padEnd(22)} median ${fmt(median(bare)).padStart(6)}`,
  );
  console.log(
    `\nLatency target: under ${fmt(LATENCY_TARGET_MS)} per hook call (reported, not enforced).`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
