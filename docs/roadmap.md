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

## M2 · Claude Code (done)

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
  The second session gets the first session's fix 48 ms after it is recorded on a
  GitHub Actions runner (about 65 ms in the development container), well within one
  second.
- **Checked:** the 50 ms hook budget, on the runner. The median hook call there takes
  47 to 49 ms for a failure, 37 ms for a success and 32 ms outside a repository,
  against 23 ms for `node -e 0`. In the development container a failure still takes
  59 to 61 ms. A failure took 111 ms before the latency work, which:
  - reads `.git` instead of running git;
  - loads `node:child_process` and `node:readline` only when they are needed;
  - uses synchronous `node:fs` calls, file-descriptor stdio, and `node:fs` without
    its ES module wrapper, so the streams stack never loads;
  - hashes with a plain-JavaScript SHA-256 instead of loading `node:crypto`.

## M3 · Codex CLI, Gemini CLI and MCP-only agents (done)

- The payloads, read off each CLI's own source rather than its docs: Gemini CLI
  0.62.0 (`AfterTool`, `BeforeAgent`, `SessionStart`, `SessionEnd`) and Codex CLI
  0.160.1 (Claude Code's event names, but no `PostToolUseFailure`, and a shell result
  without its exit code).
- The adapters (`src/gemini.ts`, `src/codex.ts`) over a shared hook input
  (`src/hook-input.ts`), so the same failure from any of the three CLIs gets the same
  fingerprint. `antibody hook gemini` and `antibody hook codex`.
- `antibody setup gemini` and `antibody setup codex`, which write the hooks (and, for
  Gemini CLI, the MCP server) into each CLI's own settings.
- For Cursor, OpenCode, Aider and others: the MCP server and one `AGENTS.md` line, in
  the README.
- **Checked:** `scripts/e2e.mjs`, run in CI, plays the M2 exchange between Claude
  Code, Gemini CLI and Codex CLI agents in all six directions, in the payload shapes
  read off their sources. Each fix arrives about 50 ms after it is recorded.
- **Open:** a check against live Gemini CLI and Codex CLI sessions with a model, which
  this environment cannot run. Codex reports no exit code to hooks, so a shell failure
  is inferred from the last line of its output; a command that fails quietly, or
  succeeds with an error-looking last line, is misread.

## M4 · `antibody watch` (done)

- The terminal fleet view, following the demo: status line, fleet, memory,
  antibodies and events panes (`src/watch-model.ts` folds the memory into the view,
  `src/watch-render.ts` lays it out). The renderer is hand-written rather than Ink,
  so the committed bundle stays free of dependencies.
- Keys: `q` quits, `space` freezes, `p` pauses injection for the whole fleet through a
  `paused` file in the memory directory, `f` cycles the events filter, and `e` opens
  `ANTIBODIES.md` in `$EDITOR`.
- `antibody stats` and `antibody watch --once` for scripts and CI.
- **Checked:** a frame of an eight-agent fleet with 5,000 events and 200 entries takes
  about 2 ms to fold and draw, at 80 columns and at 200, against the 500 ms between
  redraws (`tests/watch-render.test.ts` fails above 100 ms). Every frame is exactly
  the terminal's size and is drawn in place, so it does not flicker. The watcher was
  run with the built bundle in a pseudo-terminal.
- **Open:** opening one entry on its own (the design's `enter`), the fleet pane's task
  column and diagnosis progress bar, and the memory pane's sparkline.

## M5 · Proof

- A public benchmark repo with eight realistic tasks and the setup traps from the
  design's table.
- Run an eight-agent fleet with injection on and off, several times each, and record
  tokens, wall time and repeat diagnoses.
- Put the measured numbers at the top of the README.
- **Done when:** the numbers are reproducible from a script in the benchmark repo.

## M6 · Teams and many machines (started)

- **Export and import with a review gate (done).** `antibody export` writes the
  fixes this fleet found to a committed `ANTIBODIES.md`, redacted again and without
  notes. `antibody import` reads one into a clone's memory, held for review: the
  fix, and the title, trigger and sample of an entry that came whole, stay out of
  every agent's context (`src/review.ts`) until a person approves them with
  `antibody allow`, or turns them down with `antibody reject`, after reading them
  with `antibody review`. An import never replaces a fix, respects `wontfix`, and
  leaves out what was rejected before. The file is read with a size limit, a
  fingerprint check, text limits, hidden characters removed and a room limit.
- **Checked:** `tests/exchange-cli.test.ts` and `tests/review-cli.test.ts` run the
  exchange between two real repositories, including an agent that meets an imported
  error and is told no fix is recorded, then gets the fix once it is approved. The
  built bundle was walked through the same flow.
- **Open:** import on `SessionStart` for a clone that has no memory yet (today it is
  one command), showing what waits for review in `antibody watch`, and the opt-in
  relay for cloud agents (design Q5).
- **Open:** integration notes for herdr, vibe-kanban, superset, claude-squad,
  agent-orchestrator and paperclip.
