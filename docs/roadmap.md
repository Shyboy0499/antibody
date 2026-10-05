# Roadmap

Each milestone ends with something that can be checked, not just written.

## M0 · Concept (done)

- Market survey: [landscape.md](landscape.md)
- Design: [design.md](design.md)
- Simulated `antibody watch` screen: [demo/index.html](../demo/index.html)

## M1 · Core and shared memory (done)

- Toolchain: pnpm, TypeScript, tsdown, vitest with a 99% coverage gate, oxlint,
  prettier, and CI plus a privacy guard on every push and pull request.
- dsh-errkb's pure layer, copied with its MIT notice: fingerprints, redaction, the
  markdown store, seed entries, matching, capture, notices, fix trust, the injector,
  machine-local state and resolution detection (design Q2).
- The shared memory: `memoryDir()` in the git common directory; `ANTIBODIES.md` with
  antibody's own machine comment, still reading dsh-errkb documents; the
  `events.jsonl` event log; claims in `claims.json`.
- **Checked:** eight writer processes on one memory directory lose no event, entry
  number or counter increment, and every file still parses
  (`tests/concurrency.test.ts`). The main checkout, every linked worktree and their
  subdirectories resolve the same memory directory (`tests/memory-dir.test.ts`).

## M2 · Claude Code (done, except the latency target)

- The fleet loop (`src/fleet.ts`): claims keyed by fingerprint, claim hints, held
  fixes delivered at the next hook call, fix trust and per-session caps, with
  each session's budgets and watches kept in `sessions/<id>.json` between hook
  processes.
- `antibody hook claude-code` for `PostToolUseFailure`, `PostToolUse`,
  `SessionStart`, `UserPromptSubmit` and `SessionEnd`. It fails open and stops at a
  3-second deadline. Bundled as the committed `dist/antibody.mjs`.
- The MCP server (`antibody mcp claude-code`) with `antibody_lookup`,
  `antibody_record`, `antibody_list`, `antibody_stats` and `antibody_forget`.
- The plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json` and a marketplace
  entry. Both manifests pass `claude plugin validate`, and Claude Code's MCP health
  check connects to the server.
- **Checked:** `scripts/e2e.mjs`, run in CI, plays the scenario against the bundle.
  The second session gets the first session's fix 53 ms after it is recorded on a
  GitHub Actions runner (65 to 75 ms in the development container), well within one
  second.
- **Open:** the 50 ms hook budget. On a GitHub Actions runner the median hook call
  takes 60 ms for a failure, 44 ms for a success and 36 ms outside a repository; in
  the development container 80 to 85, 54 to 63 and 47 to 49 ms. `node -e 0` takes
  about 23 ms on both. Reading `.git` instead of running git and loading `node:crypto` and
  `node:child_process` lazily already brought a failure down from 111 ms. The next
  candidates are a smaller bundle for the hook path and skipping the store for
  successes that resolve nothing.

## M3 · Codex CLI, Gemini CLI and MCP-only agents

- Check the `PostToolUse` payload of Codex CLI and the `AfterTool` payload of Gemini
  CLI against running copies, then write both adapters.
- One `AGENTS.md` line and the MCP server for Cursor, OpenCode, Aider and others.
- **Done when:** a mixed fleet (Claude Code, Codex, Gemini) passes the M2 test in every
  direction.

## M4 · `antibody watch`

- The terminal fleet view in Ink, following the demo: status bar, fleet, memory,
  antibodies and events panes.
- Keys: pause injection, filter, open, edit in `$EDITOR`, quit.
- `antibody stats` for scripts and CI.
- **Done when:** the view keeps up with an eight-agent fleet at a few redraws a second
  without flicker, in an 80-column terminal and a wide one.

## M5 · Proof

- A public benchmark repo with eight realistic tasks and the setup traps from the
  design's table.
- Run an eight-agent fleet with injection on and off, several times each, and record
  tokens, wall time and repeat diagnoses.
- Put the measured numbers at the top of the README.
- **Done when:** the numbers are reproducible from a script in the benchmark repo.

## M6 · Teams and many machines

- `antibody export` and import with a review gate.
- Optionally, a small relay for cloud agents (design Q5).
- Integration notes for herdr, vibe-kanban, superset, claude-squad,
  agent-orchestrator and paperclip.
