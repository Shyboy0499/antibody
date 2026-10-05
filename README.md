# antibody

**Herd immunity for coding-agent fleets.** When one agent beats an error, every agent running beside it becomes immune.

![Status](https://img.shields.io/badge/status-design%20stage-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

> **Status: design stage.** There is nothing to install yet. This repository holds the
> design, the market survey behind it, and an interactive demo of the target
> experience. The [roadmap](docs/roadmap.md) says what gets built first.

![antibody fleet view](docs/fleet-view.png)

## The problem

Running many coding agents in parallel is now normal. Tools like herdr, vibe-kanban,
superset, claude-squad and paperclip will happily start eight Claude Code, Codex and
Gemini CLI sessions on one repo, each in its own git worktree.

Then all eight hit the same wall. A fresh worktree has no `.env`. The generated
Prisma client is missing. Playwright has no browsers. Port 3000 belongs to another
agent's dev server. Someone changed `package.json` and the lockfile is stale. Each
agent diagnoses the same failure on its own, from scratch, and each diagnosis costs
800 to 3,000 tokens of thinking and trial.

The bigger the fleet, the more you pay for the same answer. Nothing in the current
tools passes a fix from one running agent to the next.

## What antibody does

antibody is a small layer that sits underneath whatever runs your agents. It does
not start agents, manage worktrees or plan tasks. It watches for errors and moves
fixes between agents.

1. **Capture.** A hook fires when a tool call fails. antibody normalizes the message
   (ports, paths, timestamps and ids become placeholders) and turns it into a
   12-character fingerprint, so every agent's copy of an error matches.
2. **Claim.** The first agent to hit a new fingerprint claims it. An agent that hits
   the same error while the first is still working on it is told a peer is already
   on it, instead of starting a second diagnosis.
3. **Store.** When the claimant gets past the error, its fix goes into shared memory:
   a redacted, human-editable `ANTIBODIES.md` plus an event log.
4. **Inject.** Every agent that hits that fingerprint afterwards gets the fix pushed
   into its context through the harness's own hook, capped at 120 tokens, before it
   starts guessing.

```mermaid
sequenceDiagram
    participant A as claude-1
    participant M as antibody memory
    participant B as codex-2
    participant C as gemini-1
    A->>M: ECONNREFUSED 127.0.0.1:<port> (new fingerprint)
    M-->>A: opens E-0001, claimed by claude-1
    B->>M: same fingerprint
    M-->>B: claude-1 is already diagnosing this
    A->>M: fixed: docker compose up -d db
    M-->>B: fix from claude-1 (96 tokens)
    C->>M: same fingerprint, ten minutes later
    M-->>C: fix injected, solved in one step
```

Shared memory lives in the repository's common git directory
(`git rev-parse --git-common-dir`), which every worktree of the repo already shares.
It needs no server, no database and no configuration, and it is never committed
unless you export it.

## See it

`antibody watch` is the live fleet view, and it runs in your terminal, next to the
agents. It shows each agent's state, the antibodies in memory, the tokens saved, and
the event stream as it happens.

[`demo/index.html`](demo/index.html) is a simulated run of that screen with eight
agents. Open it in a browser and press `m` to turn shared memory off: the fleet goes
back to paying for the same diagnosis over and over.

## Works with

| Agent | How antibody connects | Fix delivery |
| --- | --- | --- |
| Claude Code | Plugin: `PostToolUseFailure` and `PostToolUse` hooks, plus an MCP server | Pushed through `additionalContext` |
| Codex CLI | `PostToolUse` hook (`~/.codex/hooks.json`), plus MCP | Pushed through the hook |
| Gemini CLI | Extension: `AfterTool` hook, plus MCP | Pushed through `hookSpecificOutput.additionalContext` |
| Cursor, OpenCode, Aider and others | MCP server only | Pulled when the agent calls `antibody_lookup` |

Hook payloads for Codex CLI and Gemini CLI are taken from their public docs and get
verified in milestone M3.

It works under any orchestrator, because it only needs the agents' own hooks:
herdr, vibe-kanban, superset, claude-squad, agent-orchestrator, paperclip, or plain
`git worktree add` and a few terminals.

## Why it can be built quickly

antibody's core comes from [dsh-errkb](https://github.com/jingchangzhao-gif/dsh-errkb),
an error knowledge base for a single DeepSeek Harness agent. Its pure layer
(fingerprinting, mandatory redaction, the markdown store, matching, fix trust and
resolution detection) is about 2,600 lines of TypeScript with no harness imports and
a 99% coverage gate. antibody keeps that core and replaces the single-harness wiring
with cross-harness hooks, shared memory and claims.

## Documents

- [Design](docs/design.md): how capture, claims, storage, injection and the fleet view work, plus failure modes and open questions
- [Landscape](docs/landscape.md): the October 2026 survey of about 40 multi-agent and agent-memory projects, and the gaps it found
- [Roadmap](docs/roadmap.md): milestones from the core port to a published benchmark

## License

[MIT](LICENSE). Code ported from dsh-errkb keeps its own MIT notice.
