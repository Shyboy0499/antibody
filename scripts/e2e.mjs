#!/usr/bin/env node
// The M2 and M3 checks, end to end, against the committed bundle
// (docs/roadmap.md). M2: two Claude Code sessions in two worktrees of one
// repository hit the same missing-.env error, and the second receives the
// first one's fix within one second of it being recorded. M3: the same
// exchange between Claude Code, Gemini CLI and Codex CLI agents, in every
// direction. Then it measures how long a hook call takes.
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

/** One hook call in its own process, as the harness makes it. */
function runHook(harness, payload) {
  const start = process.hrtime.bigint();
  const out = execFileSync(process.execPath, [BUNDLE, "hook", harness], {
    input: JSON.stringify(payload),
  }).toString();
  const elapsed = ms(start);
  const context =
    out === "" ? "" : JSON.parse(out).hookSpecificOutput.additionalContext;
  return { context, ms: elapsed };
}

/** One Claude Code hook call. */
const hook = (event, cwd, session, fields = {}) =>
  runHook("claude-code", {
    hook_event_name: event,
    session_id: session,
    cwd,
    transcript_path: join(root, `${session}.jsonl`),
    ...fields,
  });

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

// How each harness reports a failing `pnpm test` and an unrelated next call,
// in the payload shapes read off their sources (src/gemini.ts, src/codex.ts).
const HARNESSES = {
  "claude-code": {
    fail: (cwd, session, error) => ({
      hook_event_name: "PostToolUseFailure",
      session_id: session,
      cwd,
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      error: `Exit code 1\n${error}`,
    }),
    next: (cwd, session) => ({
      hook_event_name: "PostToolUse",
      session_id: session,
      cwd,
      tool_name: "Read",
      tool_input: { file_path: join(cwd, "README.md") },
      tool_response: "readme",
    }),
  },
  gemini: {
    fail: (cwd, session, error) => ({
      hook_event_name: "AfterTool",
      session_id: session,
      cwd,
      timestamp: new Date().toISOString(),
      tool_name: "run_shell_command",
      tool_input: { command: "pnpm test" },
      tool_response: {
        llmContent: `<untrusted_context>\nOutput: ${error}\nExit Code: 1\nProcess Group PGID: 4242\n</untrusted_context>`,
        returnDisplay: error,
      },
    }),
    next: (cwd, session) => ({
      hook_event_name: "AfterTool",
      session_id: session,
      cwd,
      timestamp: new Date().toISOString(),
      tool_name: "read_file",
      tool_input: { absolute_path: join(cwd, "README.md") },
      tool_response: { llmContent: "readme", returnDisplay: "" },
    }),
  },
  codex: {
    fail: (cwd, session, error) => ({
      hook_event_name: "PostToolUse",
      session_id: session,
      cwd,
      transcript_path: null,
      model: "gpt-5.5-codex",
      permission_mode: "default",
      turn_id: "t-1",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: `${error}\n`,
      tool_use_id: "call_1",
    }),
    next: (cwd, session) => ({
      hook_event_name: "PostToolUse",
      session_id: session,
      cwd,
      transcript_path: null,
      model: "gpt-5.5-codex",
      permission_mode: "default",
      turn_id: "t-2",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "README.md\n",
      tool_use_id: "call_2",
    }),
  },
};

/** A stdio MCP client for one `antibody mcp <harness>` server. */
function mcpClient(cwd, session, harness = "claude-code") {
  const child = spawn(process.execPath, [BUNDLE, "mcp", harness], {
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

  console.log(
    "\nMixed fleet: each harness hands a fix to each of the others\n",
  );
  let pair = 0;
  for (const claimer of Object.keys(HARNESSES))
    for (const receiver of Object.keys(HARNESSES)) {
      if (claimer === receiver) continue;
      pair++;
      const error = `Error: Environment variable not found: VAR_${pair}.`;
      const [sa, sb] = [`${claimer}-${pair}`, `${receiver}-${pair}`];
      const a = HARNESSES[claimer];
      const b = HARNESSES[receiver];
      const claimed = runHook(claimer, a.fail(wt("wt-a"), sa, error));
      const told = runHook(receiver, b.fail(wt("wt-b"), sb, error));
      const client = mcpClient(wt("wt-a"), sa, claimer);
      await client.start();
      const entry = /E-\d+/.exec(told.context)?.[0] ?? "";
      const pairFix = `Set VAR_${pair} in .env (pair ${pair}).`;
      await client.call("antibody_record", { id: entry, fix: pairFix });
      const at = process.hrtime.bigint();
      await client.stop();
      const got = runHook(receiver, b.next(wt("wt-b"), sb));
      const after = ms(at);
      check(
        claimed.context === "" &&
          told.context.includes(`${claimer}@wt-a has been diagnosing this`) &&
          got.context.includes(pairFix) &&
          after < DELIVERY_LIMIT_MS,
        `${claimer} -> ${receiver}: told who is on it, then got the fix ${fmt(after)} after it was recorded`,
      );
    }

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
