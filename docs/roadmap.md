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

## M5 · Proof (started)

- **Measured diagnosis cost (done).** A fix records what its diagnosis cost, read from
  the claimant's transcript between its claim and the fix (`src/transcript.ts`, for
  the Claude Code, Codex CLI 0.160.1 and Gemini CLI 0.62.0 formats), and
  `antibody stats` and `antibody watch` count each reused fix at that cost instead of
  the assumed 800 tokens, saying how many were measured. **Checked:** the reader
  matches a count by hand on a real 22 MB Claude Code transcript, and the built bundle
  carried a measured cost from a hook's claim, through `antibody mcp`'s
  `antibody_record`, into `stats` and `watch`.
- **The benchmark harness (done).** [`bench/`](../bench/README.md) holds a project
  that sets four of the design's traps (a stale lockfile, a missing `.env`, an
  uncommitted generated client and a busy port), eight tasks with hidden acceptance
  checks, and `pnpm run bench`. That runs the same fleet with injection on and off,
  several times each, and reports the median run of each arm: tokens from the
  agents' transcripts, wall time, trap diagnoses, repeat diagnoses and tasks done.
  It drives scripted agents, which cost nothing and check the runner, and real
  Claude Code agents, each with its own spending cap. **Checked:** the scripted
  agents run through the committed bundle end to end, and the Claude Code driver
  against a stand-in for `claude` that runs the hooks it was given. It lives in this
  repository; a separate public benchmark repo is still open.
- **The scripted runs are unpiped (recorded).** Their agents run `npm test` on its own, so
  the four traps reach a hook as failures and the piped shape real agents use does not
  appear in the numbers (#131). Rerunning them piped is what measures the fix; the
  scripted agent has no switch for it yet.
- **Protocol fixes the benchmark found (done).** Scripted agents in the harness
  showed antibody's protocol holding its own fixes back:
  - a hook that claimed an error could read the memory just before a peer's fix
    landed, and tell its agent there was none (#115);
  - a request for a fix that the notice budget refused was lost for good (#117);
  - a test run that stops on one setup error after another resolved none of them
    until the whole run passed, so their fixes were asked for late (#118);
  - claim hints spent the turn's budget that the fix they promised needed, and a
    headless agent, whose task is one long turn, heard three notices in all (#120,
    #121, #122).

  **Checked:** eight scripted agents, fixes recorded only when asked, two runs per
  arm at real speed. With injection on: 5 trap diagnoses (1 repeat) and 76,470
  tokens, against 32 (28 repeats) and 126,400 tokens off, so 40% fewer tokens.
  Before the fixes, recording only when asked, injection changed nothing (four
  agents: 16 diagnoses either way). Wall time was 28% longer with injection on: a
  scripted diagnosis takes 4 seconds, about as long as a hand-over, so waiting for a
  peer's fix does not pay there. Real diagnoses take far longer, which the real runs
  will show.
- **A run whose sessions were stopped is left out (done).** Claude Code reports `is_error`
  and its own `terminal_reason` on every turn, and `completed` is the one that ran to the
  end. Anything else - an API error, a usage limit, the turn or budget cap the benchmark
  sets - is recorded as an agent error, and a run with one is excluded from the medians and
  listed under the table rather than scored as a fleet that did nothing (#133).
- Run an eight-agent Claude Code fleet with injection on and off, several times
  each. This needs a real run's budget.
- Put the measured numbers at the top of the README.
- **Done when:** the numbers are reproducible from a script in the benchmark.

## M6 · Teams and many machines (done)

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
- `antibody watch` says how many entries wait for review and marks them in the
  antibodies pane, and `antibody stats` lists their IDs.
- **Import on session start (done).** A clone's first session imports a committed
  `ANTIBODIES.md` into a memory that has nothing yet, held for review, and tells its
  agent a person must review it. A marker created exclusively makes it once per
  clone, however many sessions start together. `ANTIBODY_AUTO_IMPORT=0` turns it
  off.
- **The relay (done, design Q5).** `antibody relay serve` keeps the latest fix for
  each fingerprint for several machines; `antibody relay sync`, and the agents' MCP
  server every 30 seconds, push this machine's new fixes and pull the others'. Pulled
  fixes are held for review unless `ANTIBODY_RELAY_TRUST=fleet`. **Checked:**
  `tests/relay-client.test.ts` syncs two real repositories through a real relay,
  held and trusted, and an MCP server records a fix that reaches the relay before it
  stops.
- **Integration notes (done).** [`docs/integrations.md`](integrations.md) says, for
  herdr, vibe-kanban, superset, claude-squad, agent-orchestrator and paperclip, how
  each lays out its agents' work, from its own README, and what antibody needs there:
  nothing beyond installing it in each harness when agents work in worktrees of one
  repository, and a committed export or a relay when they work on separate machines.
