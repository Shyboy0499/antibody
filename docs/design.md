# antibody design

Status: draft, October 2026. Milestones M1 (core and shared memory), M2 (the
Claude Code plugin and the MCP server), M3 (the Gemini CLI and Codex CLI adapters)
and M4 (`antibody watch`) are implemented, M5 has begun with measured diagnosis cost,
and M6 with export and import.
Statements about other tools' hook APIs come from their public documentation and
are marked where they still need to be checked against a running copy.

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
├── ANTIBODIES.md          human-readable entries, dsh-errkb's ERRORS.md format
├── ANTIBODIES.archive.md  entries moved out of the main document, never deleted
├── events.jsonl           append-only event log: hits, misses, claims, fixes, notices
├── state.json             hit counters and fix-trust records
├── claims.json            which agent is diagnosing which entry, with a time to live
├── .lock                  advisory lock taken by every rewrite
├── antibodies.index.json  reserved, not written yet
└── .machine.json          reserved, not written yet
```

`memoryDir()` in `src/paths.ts` resolves this directory, and `filesIn()` names the
files in it.

Every linked worktree reports the same common git directory, so every agent in every
worktree of the repo sees the same memory with no configuration. The directory is
inside `.git`, so it is never committed by accident.

### 4.2 Concurrency

Eight agents can fail at the same moment, so writes are designed for contention:

- `events.jsonl` is appended with `O_APPEND`, one JSON line per event, each kept under
  4 KB so appends do not interleave on local filesystems.
- `ANTIBODIES.md`, `state.json` and `claims.json` are rewritten under an advisory lock
  taken with an exclusive create of `.lock`, then written to a temporary file and
  renamed into place. A lock older than 10 seconds is treated as stale.
- Claims carry a time to live (10 minutes by default) and are released early when the
  claiming session ends, so a crashed agent cannot hold an entry forever.

The milestone M1 acceptance test, `tests/concurrency.test.ts`, runs eight writer
processes against one memory directory and checks that no event, entry number or
counter increment is lost and that every file still parses.

### 4.3 Beyond one machine

Cloud agents and teammates do not share a `.git` directory. Milestone M6 has the
first of two options built:

- **Export and import (built).** `antibody export` writes the fixes this fleet found
  to a committed `ANTIBODIES.md`: only entries with a working fix that were not
  themselves imported and unreviewed, redacted again, without notes. A fresh clone
  runs `antibody import`, and what comes in is held until a person approves it, the
  way `direnv allow` works (§9). An entry the clone already has a fix for keeps its
  own, a `wontfix` is respected, and a fix a person rejected is not brought back.
- **Relay (open, Q5).** A small optional HTTP service that several machines'
  memories sync through.

## 5. Harness adapters

Each adapter is the same small command, `antibody hook <harness> <event>`, which reads
the hook JSON on stdin and prints the harness's response format. It must answer
quickly: no network, no model calls, a budget of 50 ms in the normal case and a hard
timeout of 2 s. On any internal error it prints nothing and exits 0, so antibody can
never break or block an agent.

| Harness | Capture | Inject | Notes |
| --- | --- | --- | --- |
| Claude Code | `PostToolUseFailure` (receives `error`), and `PostToolUse` for Bash calls that exit non-zero | `hookSpecificOutput.additionalContext` on every event | Built (M2): the repository is the plugin, with `hooks/hooks.json` and an MCP server declared in `.claude-plugin/plugin.json`. Successful `PostToolUse` calls resolve watched entries; `SessionStart` and `UserPromptSubmit` deliver held fixes and start a turn; `SessionEnd` releases the session's claims. |
| Codex CLI | `PostToolUse` in `~/.codex/hooks.json`, whose shell result is the output text without the exit code | `hookSpecificOutput.additionalContext`, as Claude Code | Built (M3), checked against the 0.160.1 source: `antibody setup codex` writes the hooks, and Codex runs them once trusted in `/hooks`. A shell failure is inferred from the output's last line; the MCP server is added with `codex mcp add`. |
| Gemini CLI | `AfterTool`, whose shell result carries an `Exit Code: N` line rather than an error | `hookSpecificOutput.additionalContext`, which Gemini appends to the tool result in `<hook_context>` | Built (M3), checked against the 0.62.0 source: `antibody setup gemini` writes the hooks and the MCP server into `~/.gemini/settings.json`. An extension would need this repository's root `hooks/hooks.json`, which the Claude Code plugin owns. |
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

Keys: `p` pauses injection (useful for an honest with-and-without comparison), `f`
cycles the events between all, failures and fixes, `e` opens `ANTIBODIES.md` in
`$EDITOR`, `space` freezes the view, `q` quits.
[`demo/index.html`](../demo/index.html) simulates the screen.

Implementation (M4): a hand-written renderer instead of Ink, so the committed bundle
keeps no dependencies. It draws every frame at exactly the terminal's size, in place
on the alternate screen. Pausing writes a `paused` file to the memory directory,
which every hook checks: the fleet loop runs with injection off, and fixes held
meanwhile are delivered when it resumes. Not built yet: the task column and progress
bar in the fleet pane, the sparkline, the branch in the status bar, and opening a
single entry. `antibody stats` prints the ledger once, without the screen, for scripts
and CI.

## 7. What carries over from dsh-errkb

dsh-errkb's pure layer had no DeepSeek Harness imports, so it came over almost
unchanged:

| dsh-errkb file | antibody file | Changes |
| --- | --- | --- |
| `src/signature.ts` | `src/signature.ts` | None |
| `src/redact.ts`, `src/redact-patterns.ts` | the same | None |
| `src/paths.ts` | `src/paths.ts` | File layout only; `memoryDir()` replaces the DeepSeek Harness directory tiers |
| `src/store.ts` | `src/store.ts` | `ANTIBODIES.md` file names; writes `<!-- antibody: … -->` and still reads `<!-- errkb: … -->` |
| `src/match.ts` | `src/match.ts` | None |
| `src/capture.ts` | `src/capture.ts` | None |
| `src/inject.ts` | `src/notice.ts`, `src/trust.ts`, `src/injector.ts` | Split in three; the DeepSeek Harness message source is dropped; notices open with `[antibody]` |
| `src/resolve-detect.ts` | `src/resolve-detect.ts` | The fix request names `antibody_record` |
| `src/state.ts` | `src/state.ts` | Imports `TrustRecord` from `src/trust.ts` |

New in antibody: `src/events.ts` (the event log), `src/claims.ts` (claims) and
`memoryDir()`. The DeepSeek Harness wiring (`src/index.ts`, `src/plugin.ts`) stays
behind. In M2 `src/tools.ts` came over as harness-neutral tools behind an MCP server
(`src/mcp.ts`), and the fleet loop (`src/fleet.ts`), the session file
(`src/session.ts`) and the Claude Code adapter (`src/claude-code.ts`) replace the
plugin wiring.

dsh-errkb is MIT licensed, copyright 2026 jingchangzhao-gif. Decided under Q2: the
files are copied, each starting with a comment naming its source, and `NOTICE`
carries dsh-errkb's licence. Extracting a package both projects depend on stays
possible later if the two codebases need to share fixes.

## 8. Cost model

| Event | Model tokens |
| --- | --- |
| Error with no entry, or tool call that succeeds | 0 |
| Hit with a trusted fix | The notice, at most 120 |
| Hit on a claimed entry | The claim hint, at most 60, then the fix when it lands |
| Resolution prompt to the claimant | One prompt of at most 80 tokens |
| Environment broadcast (off by default) | At most 300 per session start |

Tokens saved per reused fix = the recorded diagnosis cost − the notice. The recorded
cost is measured from the claimant's own transcript: the claim event names the file
the harness gave the hook, and when the fix is recorded antibody adds up what the
model newly read or wrote between the claim and the fix - input, cache writes and
output, not the context re-read from the prompt cache each turn, which is the same
measure as a notice's tokens. It is an upper bound when the claimant did other work
in between. Without a transcript antibody can read, it falls back to dsh-errkb's
conservative 800-token assumption, and `antibody stats` and `antibody watch` say how
many costs were measured. `antibody stats` never reports a negative saving.

Milestone M5 replaces these estimates with a measured benchmark.

## 9. Safety and privacy

- **Redaction before every write.** Keys, tokens, passwords, emails and absolute paths
  are removed or collapsed by dsh-errkb's redaction before anything reaches disk. The
  one exception is the claimant's transcript path on a claim event, kept as it is
  because it is read back to measure the diagnosis: it names a file on this machine,
  and `events.jsonl` is never exported.
- **Local by default.** Memory never leaves the machine unless someone runs
  `antibody export` or configures a relay.
- **Prompt injection.** Injected fixes are text other agents wrote, so they are an
  injection surface. Mitigations: only agents in this repository's fleet write to its
  memory; every notice is framed as advice from a named peer, never as an instruction
  from the user; fixes that keep failing lose trust. Imported entries stay untrusted
  until a person approves them. What is held is not only the fix: the title, trigger
  and sample of an entry that came whole are text someone else wrote, and agents
  read them in lookups and notices, so they are held too (`src/review.ts`).
  `antibody review` shows a person everything that waits, stripped of control,
  hidden and direction-changing characters; `antibody allow` approves it and
  `antibody reject` archives it. The imported file is read with a size limit, a
  fingerprint check, text limits and a limit on how many entries it may add.
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
- **Q2 Shared core. Decided:** copied, with dsh-errkb's MIT notice in `NOTICE` and a
  source comment at the top of every ported file (section 7).
- **Q3 Environment broadcast.** Keep it off, or turn it on by default once M5 measures
  it.
- **Q4 Claim behaviour.** Should a claim hint only inform, or also suggest the agent
  switches to other work until the fix arrives?
- **Q5 Cross-machine sharing.** Export and import first, or a relay first.
