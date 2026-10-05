# antibody design

Status: draft, October 2026. Nothing here is implemented yet. Statements about
other tools' hook APIs come from their public documentation and are marked where
they still need to be checked against a running copy.

## 1. What antibody is

antibody is a shared error memory for a fleet of coding agents working on the same
repository. When one agent gets past an error, the fix is stored, and every other
agent that meets the same error gets that fix in its context before it starts
diagnosing.

It is deliberately narrow:

- **It is not an orchestrator.** It does not start agents, create worktrees, assign
  tasks or merge branches. It runs under whatever does: herdr, vibe-kanban, superset,
  claude-squad, agent-orchestrator, paperclip, or a few terminals.
- **It is not general memory.** It stores errors and the fixes that beat them. It
  does not summarize sessions, embed documents or keep a vector store. That narrowness
  is what keeps it fast, cheap and measurable.
- **It needs no server.** On one machine, shared memory is a directory every worktree
  of the repo can already see.

## 2. The problem in numbers

dsh-errkb's design puts one re-diagnosis at 800 to 3,000 tokens of thinking and
trial, plus minutes of wall time. A single agent meets a repeat error now and then.
A fleet meets them constantly, because parallel agents in fresh worktrees all start
from the same broken state at the same moment.

Many of the errors are specific to running agents in parallel:

| Error a fleet hits | Why parallel agents hit it |
| --- | --- |
| `Environment variable not found: DATABASE_URL` | `git worktree add` does not copy untracked files such as `.env` |
| `Cannot find module './generated/client'` | Generated code is untracked, so each fresh worktree lacks it |
| `listen EADDRINUSE :::<port>` | Several agents start dev servers on the same default port |
| `fatal: 'main' is already checked out at '<path>'` | A branch can be checked out in only one worktree |
| `ERR_PNPM_OUTDATED_LOCKFILE` | One agent changed `package.json`, the others still run `--frozen-lockfile` |
| `Migration "…" failed: relation already exists` | Two agents generated the same migration against a shared dev database |
| `browserType.launch: Executable doesn't exist` | Tool caches such as Playwright's browsers are per machine or per container |

For a fleet of N agents that all meet k such errors, the waste is up to
(N − 1) × k diagnoses. With eight agents and five shared errors that is 35 extra
diagnoses, roughly 28,000 to 105,000 tokens, before any real work gets done. The
waste grows with fleet size, so the value of antibody grows with it too.

## 3. The loop

```
 agent tool call fails
        │
        ▼
 ┌──────────────┐   normalize + fingerprint   ┌───────────────────────┐
 │ harness hook │ ──────────────────────────▶ │ look up shared memory │
 └──────────────┘                             └───────────┬───────────┘
                      ┌───────────────────────────────────┼─────────────────────────────┐
                      ▼                                   ▼                             ▼
             known, trusted fix                 claimed by another agent          unknown
           inject fix (≤ 120 tok)            inject claim hint (≤ 60 tok)    open entry, claim it
                                                                                        │
                                                       agent gets past the error ◀──────┘
                                                                  │
                                                                  ▼
                                                 store fix, release claim, notify holders
```

### 3.1 Capture

A hook fires after a failed tool call. antibody reads the hook's JSON from stdin,
pulls out the error text and normalizes it with the dsh-errkb rules: ANSI codes,
timestamps, durations, PIDs, ports, line and column numbers, UUIDs, hashes, temp
directories and absolute paths become placeholders, while the words, the codes and
the last segment of each path stay. The fingerprint is a 12-character hash of the
normalized text plus its category, so the same failure in eight worktrees produces
one fingerprint.

Noise rules from dsh-errkb carry over: transient failures (rate limits, timeouts)
are counted but only recorded after they repeat, and permanent ones are recorded on
first sight.

### 3.2 Look up

A hit has three outcomes:

- **Known with a trusted fix.** antibody returns the fix through the hook's
  context-injection field. The notice is capped at 120 tokens and names the agent
  that found it, so the receiving model can weigh it.
- **Claimed.** Another agent opened this entry and is still working on it. antibody
  returns a short claim hint ("codex-2 has been diagnosing this for 40 s; its fix
  will be passed to you"). The agent is informed, never blocked.
- **Unknown.** antibody opens a new entry and records a claim for this agent.

A miss costs no model tokens. The hook prints nothing.

### 3.3 Resolve

An entry gets its fix in one of two ways:

1. **Automatic.** dsh-errkb's resolution detection: when the claiming agent's next
   comparable command succeeds after the failure, the commands and edits between the
   two are summarized into a candidate fix, and the agent gets one short prompt to
   confirm or correct it with `antibody_record`.
2. **Explicit.** The agent, or a person, calls `antibody_record` with the entry id
   and the fix.

Recording a fix releases the claim. Agents that were holding on that entry receive
the fix at their next hook event.

### 3.4 Trust

Fix trust comes from dsh-errkb: if the same agent hits the same fingerprint again
soon after a fix was injected, the fix is doubted; after a second failure it is
suppressed and the entry goes back to open. Each successful reuse adds trust. People
can edit or delete any entry in `ANTIBODIES.md` directly.

### 3.5 Delivery to other agents

The default is **hit-only**: an agent hears about a fix when it meets the error, plus
the agents that were holding on that entry. Broadcasting every new fix to every
running agent would spend tokens on errors most agents never meet.

An optional **environment broadcast** mode pushes fixes tagged as environment setup
(missing `.env`, uninstalled browsers, ungenerated clients) to agents at session
start, in a block capped at 300 tokens. It stays off until measurements show it pays
for itself.

## 4. Shared memory

### 4.1 Where it lives

On one machine, memory lives in the repository's common git directory:

```
$(git rev-parse --git-common-dir)/antibody/
├── ANTIBODIES.md   human-readable entries, same format as dsh-errkb's ERRORS.md
├── events.jsonl    append-only event log: hits, claims, fixes, injections
├── state.json      counters, open claims, trust records
└── lock            advisory lock for rewrites of the two files above
```

Every linked worktree reports the same common git directory, so every agent in every
worktree of the repo sees the same memory with no configuration. The directory is
inside `.git`, so it is never committed by accident.

### 4.2 Concurrency

Eight agents can fail at the same moment, so writes are designed for contention:

- `events.jsonl` is appended with `O_APPEND`, one JSON line per event, each kept under
  4 KB so appends do not interleave on local filesystems.
- `ANTIBODIES.md` and `state.json` are rewritten under an advisory lock taken with an
  exclusive create of `lock`, then written to a temporary file and renamed into
  place. A lock older than 10 seconds is treated as stale.
- Claims carry a time to live (10 minutes by default) and are released early when the
  claiming session ends, so a crashed agent cannot hold an entry forever.

The milestone M1 acceptance test runs eight writer processes against one memory
directory and checks that no event is lost and no file is corrupted.

### 4.3 Beyond one machine

Cloud agents and teammates do not share a `.git` directory. Two later options, to be
chosen in milestone M6:

- **Export and import.** `antibody export` writes reviewed, redacted entries to a
  committed `ANTIBODIES.md`. A fresh clone imports them as untrusted until a person
  approves them, the way `direnv allow` works.
- **Relay.** A small optional HTTP service that several machines' memories sync
  through.

## 5. Harness adapters

Each adapter is the same small command, `antibody hook <harness> <event>`, which reads
the hook JSON on stdin and prints the harness's response format. It must answer
quickly: no network, no model calls, a budget of 50 ms in the normal case and a hard
timeout of 2 s. On any internal error it prints nothing and exits 0, so antibody can
never break or block an agent.

| Harness | Capture | Inject | Notes |
| --- | --- | --- | --- |
| Claude Code | `PostToolUseFailure` (receives `error`), and `PostToolUse` for Bash calls that exit non-zero | `hookSpecificOutput.additionalContext` on both events | Shipped as a plugin with `hooks/hooks.json` and an MCP server. `SessionStart` for the optional environment broadcast, `Stop` to release claims. |
| Codex CLI | `PostToolUse` in `~/.codex/hooks.json` (hooks reached general availability in May 2026) | The hook's replacement of the tool result | Payload field names to verify in M3. MCP server for the tools. |
| Gemini CLI | `AfterTool` | `hookSpecificOutput.additionalContext`, which Gemini appends to the tool result | Shipped as an extension. Payload to verify in M3. |
| Cursor, OpenCode, Aider, others | None | None | MCP server only. Agents pull fixes by calling `antibody_lookup`, prompted by one line in `AGENTS.md`. |

### 5.1 MCP tools

The five dsh-errkb tools, renamed:

| Tool | Does |
| --- | --- |
| `antibody_lookup` | Look an error up by message or id, with the closest matches on a miss |
| `antibody_record` | Record or correct the fix for an entry |
| `antibody_list` | List entries, filtered by status or category |
| `antibody_stats` | Tokens saved, hits, injections, open entries, doubted fixes |
| `antibody_forget` | Archive an entry with a reason |

### 5.2 Naming agents

Each event records the harness, the session id and the worktree path. The name shown
in `antibody watch` and in notices is `ANTIBODY_AGENT` when set (orchestrators can set
it per agent), otherwise the harness name plus the worktree's directory name.

## 6. `antibody watch`

The fleet view runs in the terminal, beside the agents, as a full-screen TUI. It
tails `events.jsonl` and redraws a few times a second.

- **Status bar:** repository, branch, number of agents, whether injection is on, how
  many agents are diagnosing, elapsed time.
- **Fleet pane:** one row per agent with its task, state (working, diagnosing,
  holding, immune) and detail: the entry it is on, a progress bar and the tokens
  burning while it diagnoses.
- **Memory pane:** tokens saved after the cost of notices, re-diagnoses avoided,
  antibodies stored and open, fleet immunity (the share of error hits answered from
  memory), and a sparkline of tokens saved over time.
- **Antibodies pane:** the entries, with fingerprint, normalized error, fix, the agent
  that found it, reuse count and tokens saved.
- **Events pane:** the live stream.

Keys: `p` pauses injection (useful for an honest with-and-without comparison), `/`
filters, `enter` opens an entry, `e` edits it in `$EDITOR`, `q` quits.
[`demo/index.html`](../demo/index.html) simulates the screen.

Implementation: TypeScript with Ink, which renders React components to the terminal
and is what Claude Code itself uses. `antibody stats` prints the same numbers once,
without the TUI, for scripts and CI.

## 7. What carries over from dsh-errkb

dsh-errkb's pure layer has no DeepSeek Harness imports:

| dsh-errkb file | Role in antibody |
| --- | --- |
| `src/signature.ts` | Normalization and fingerprints, unchanged |
| `src/redact.ts`, `src/redact-patterns.ts` | Mandatory redaction on every write, unchanged |
| `src/store.ts` | Parse, render, append and archive the markdown store, renamed to `ANTIBODIES.md` |
| `src/match.ts` | Exact and near matching, closest entries on a miss |
| `src/state.ts` | Counters and trust, extended with claims |
| `src/capture.ts` | Classification and the noise rule |
| `src/resolve-detect.ts` | Resolution detection |

Together these are about 2,600 lines under a 99% coverage gate. The DeepSeek Harness
wiring (`src/index.ts`, `src/plugin.ts`, `src/tools.ts`, the harness-specific parts
of `src/inject.ts` and `src/paths.ts`) is replaced by the adapters and the shared
store.

dsh-errkb is MIT licensed, copyright 2026 jingchangzhao-gif. Ported files keep that
notice. The cleaner long-term option is to extract the pure layer into a package both
projects depend on, so fixes land in one place. See question Q2.

## 8. Cost model

| Event | Model tokens |
| --- | --- |
| Error with no entry, or tool call that succeeds | 0 |
| Hit with a trusted fix | The notice, at most 120 |
| Hit on a claimed entry | The claim hint, at most 60, then the fix when it lands |
| Resolution prompt to the claimant | One prompt of at most 80 tokens |
| Environment broadcast (off by default) | At most 300 per session start |

Tokens saved per reused fix = the recorded diagnosis cost − the notice. The recorded
cost is measured from the claimant's own diagnosis (token usage between the failure
and the fix, where the harness reports it), falling back to dsh-errkb's conservative
800-token assumption. `antibody stats` never reports a negative saving.

Milestone M5 replaces these estimates with a measured benchmark.

## 9. Safety and privacy

- **Redaction before every write.** Keys, tokens, passwords, emails and absolute paths
  are removed or collapsed by dsh-errkb's redaction before anything reaches disk.
- **Local by default.** Memory never leaves the machine unless someone runs
  `antibody export` or configures a relay.
- **Prompt injection.** Injected fixes are text other agents wrote, so they are an
  injection surface. Mitigations: only agents in this repository's fleet write to its
  memory; every notice is framed as advice from a named peer, never as an instruction
  from the user; fixes that keep failing lose trust; imported entries stay untrusted
  until a person approves them; `antibody review` lists new fixes for a person to
  check.
- **Fail open.** Any internal error means no output and exit code 0.

## 10. Failure modes

| Failure | Mitigation |
| --- | --- |
| Two different errors share a fingerprint | Normalization keeps words, codes and file names; the collision rate is tested on real logs in M1 |
| A stale fix keeps getting injected | Trust decay; suppression after two failures; `antibody_forget` |
| Too many notices in one session | Per-session caps from dsh-errkb (notices per hour and tokens per session) |
| A claimant crashes | Claim time to live, release on session end |
| Concurrent writers corrupt the store | Append-only log, lock plus rename for rewrites, the eight-writer test |
| A slow hook delays the agent | 50 ms budget, 2 s hard timeout, fail open |

## 11. Open questions

- **Q1 Package name.** `antibody` is taken on npm. Candidates: `antibodies`,
  `@antibody/cli`, or a scoped name under the owner's account.
- **Q2 Shared core.** Copy dsh-errkb's pure layer with its notice, or extract it into a
  package both projects depend on. Extraction is cleaner but needs the dsh-errkb
  owner's agreement.
- **Q3 Environment broadcast.** Keep it off, or turn it on by default once M5 measures
  it.
- **Q4 Claim behaviour.** Should a claim hint only inform, or also suggest the agent
  switches to other work until the fix arrives?
- **Q5 Cross-machine sharing.** Export and import first, or a relay first.
