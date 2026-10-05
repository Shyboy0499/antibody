# Roadmap

Each milestone ends with something that can be checked, not just written.

## M0 · Concept (done)

- Market survey: [landscape.md](landscape.md)
- Design: [design.md](design.md)
- Simulated `antibody watch` screen: [demo/index.html](../demo/index.html)

## M1 · Core and shared memory

- Toolchain matching dsh-errkb: pnpm, TypeScript, tsdown, vitest with a 99% coverage
  gate, oxlint, prettier, CI on every push and pull request.
- Bring over dsh-errkb's pure layer (fingerprints, redaction, store, matching, state,
  capture, resolution detection), either copied with its MIT notice or as a shared
  package (design Q2).
- The shared store in the git common directory: `events.jsonl`, `ANTIBODIES.md`,
  `state.json`, the lock-and-rename rewrite, claims with a time to live.
- **Done when:** eight writer processes hammering one memory directory lose no event
  and corrupt no file, and every linked worktree of a test repo resolves the same
  memory directory.

## M2 · Claude Code

- Plugin: `hooks/hooks.json` wiring `PostToolUseFailure`, `PostToolUse` (Bash exits
  that are not zero), `SessionStart` and `Stop` to `antibody hook claude-code <event>`.
- MCP server with `antibody_lookup`, `antibody_record`, `antibody_list`,
  `antibody_stats` and `antibody_forget`.
- Claims, claim hints, trust, per-session caps.
- **Done when:** two Claude Code sessions in two worktrees of one repo hit the same
  missing-`.env` error, and the second session receives the first session's fix within
  one second of it being recorded, with the hook adding under 50 ms per call.

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
