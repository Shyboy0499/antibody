# antibody

**Herd immunity for coding-agent fleets.** When one agent beats an error, every agent running beside it becomes immune.

![Status](https://img.shields.io/badge/status-M6%3A%20many%20machines-yellowgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

> **Status: M6, fixes that travel between machines.** antibody installs as a Claude
> Code plugin, and `antibody setup` adds it to Gemini CLI and Codex CLI. Hooks capture
> errors, claims keep two agents from diagnosing the same new one, and a recorded fix
> reaches the other sessions in the repository at their next tool call, whichever CLI
> they run. Five MCP tools let any agent look errors up and record fixes, and
> `antibody watch` shows the fleet live. Fixes reach other clones through a committed
> file or an optional relay. The [benchmark](bench/README.md) that will measure it is
> built; its real runs come next, and the [roadmap](docs/roadmap.md) has the rest.

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

## Install in Claude Code

antibody needs Node.js 22.13 or newer on your `PATH`. In Claude Code:

```text
/plugin marketplace add Shyboy0499/antibody
/plugin install antibody@antibody
```

Then restart Claude Code. The plugin is the repository itself: its hooks run the
committed `dist/antibody.mjs`, so there is nothing to build. From then on every
session in every git repository takes part. Sessions in different worktrees of one
repository share a memory, and sessions in different repositories do not.

What happens next is automatic:

- A tool call fails. The hook fingerprints the error. If it is new, this session
  claims it and records it in `ANTIBODIES.md`, and the agent sees nothing.
- Another session hits the same error. If the first is still on it, the second is
  told who is diagnosing it, and waits for the fix instead of starting over. If a fix
  is known, it is pushed into the agent's context, within 120 tokens.
- The agent gets past the error. antibody notices the next comparable call succeed,
  or the same command fail on a different error, and asks once for the fix, which
  the agent records with `antibody_record`. The sessions that were waiting get it at
  their next tool call.

antibody says at most one thing per tool call and three per turn. In a long turn,
such as a headless run, the three start again every ten tool calls. Telling an agent
that a peer is on its error, and then handing it the peer's fix, never counts against
the three. A request for a fix that could not be sent yet waits for the next call.

The MCP server gives every session five tools: `antibody_lookup`, `antibody_record`,
`antibody_list`, `antibody_forget` and `antibody_stats`. The memory is plain files
you can read and edit:

```sh
cat "$(git rev-parse --git-common-dir)/antibody/ANTIBODIES.md"
```

A hook never blocks or breaks a session. Outside a repository, on any error, or past
three seconds it prints nothing. Set `ANTIBODY_DEBUG=1` to see why on stderr.

### Measured

[`scripts/e2e.mjs`](scripts/e2e.mjs) runs the M2 check against the committed bundle,
the way Claude Code calls it, and CI runs it on every push. Two sessions in two
worktrees hit the same missing-`.env` error. The fix the first session records reaches
the second on its next tool call: **48 ms** later on a GitHub Actions runner, and
about 65 ms later in the development container. It then plays the same exchange
between Claude Code, Gemini CLI and Codex CLI agents in all six directions, and each
fix arrives about 50 ms after it is recorded.

Each hook call is a separate Node.js process, so most of its cost is starting one. A
hook loads nothing beyond Node's own start-up: it starts no git process, hashes in
plain JavaScript instead of loading `node:crypto`, and keeps the streams stack out. The
median hook call takes:

| Call | GitHub Actions runner | Development container |
| --- | ---: | ---: |
| A tool call fails | 47 to 49 ms | 59 to 61 ms |
| A tool call succeeds | 37 ms | 44 to 46 ms |
| Outside a git repository | 32 ms | 37 to 38 ms |
| `node -e 0`, for scale | 23 ms | 26 to 29 ms |

The roadmap's target is under 50 ms per call. On the runner every kind of call meets
it; in the development container a failing call is still about 10 ms over.

`antibody stats` and `antibody watch` count a reused fix at what its diagnosis was
measured to cost. When an agent records a fix, antibody reads the claimant's own
transcript (every supported CLI names it in its hook calls) and adds up the tokens the
model newly read or wrote between the claim and the fix, leaving out the context it
re-read from its prompt cache. Where there is no transcript to read, a diagnosis is
assumed to cost 800 tokens, and both commands say how many costs were measured.

## Install in Gemini CLI and Codex CLI

Neither CLI can share this repository as a plugin, so `antibody setup` writes
antibody into their own settings. Clone the repository anywhere, then run setup for
each CLI you use:

```sh
git clone https://github.com/Shyboy0499/antibody ~/.local/share/antibody
node ~/.local/share/antibody/dist/antibody.mjs setup gemini   # ~/.gemini/settings.json
node ~/.local/share/antibody/dist/antibody.mjs setup codex    # ~/.codex/hooks.json
```

- **Gemini CLI** gets hooks on `SessionStart`, `BeforeAgent`, `AfterTool` and
  `SessionEnd`, plus the MCP server. Restart Gemini CLI to load them.
- **Codex CLI** gets hooks on `SessionStart`, `UserPromptSubmit`, `PostToolUse` and
  `SessionEnd`. Codex runs new hooks once you trust them in `/hooks`, and setup prints
  the `codex mcp add` command for the MCP server. Codex gives a hook a shell command's
  output but not its exit code, so antibody counts a command as failed only when its
  output ends in an error line, and never for commands that only display text (`cat`,
  `grep`, `git log` and the like).

Run setup again after moving the clone. `--remove` takes antibody out again,
`--print` shows the result without writing it, and a settings file with comments is
never rewritten.

### Other agents

Any agent that speaks MCP can use the tools. It pulls fixes instead of having them
pushed. Point it at the server, named after the agent:

```json
{
  "mcpServers": {
    "antibody": {
      "command": "node",
      "args": ["/path/to/antibody/dist/antibody.mjs", "mcp", "cursor"]
    }
  }
}
```

and add one line to the project's `AGENTS.md`:

```markdown
When a command fails with an error you have not seen, call antibody_lookup before
diagnosing it; when you get past it, record the fix with antibody_record.
```

The server finds the repository from the directory it starts in, so configure it per
project.

## See it

`antibody watch` is the live fleet view, in your terminal next to the agents. Run it
from any worktree of the repository, with the bundle from your clone:

```sh
node ~/.local/share/antibody/dist/antibody.mjs watch
```

It shows what each agent is doing (diagnosing an error it claimed, holding for a
peer's fix, immune because a fix was just pushed to it, or working), the tokens saved
and the re-diagnoses avoided, every antibody with its fix and who found it, how many
imported entries wait for your review, and the events as they happen. It redraws
twice a second, in place, on the terminal's alternate screen.

| Key | Does |
| --- | --- |
| `q` | Quit |
| `space` | Freeze the view, and resume it |
| `p` | Pause injection for the whole fleet, and resume it: hooks keep recording but tell the agents nothing, and fixes held meanwhile arrive once it resumes |
| `f` | Show all events, failures only, or fixes only |
| `e` | Open `ANTIBODIES.md` in `$VISUAL` or `$EDITOR` |

`antibody watch --once` prints a single frame for a pipe, sized by `COLUMNS` and
`LINES`, and `antibody stats` prints the ledger as text for scripts and CI.

[`demo/index.html`](demo/index.html) is a simulated run of the same screen with
eight agents. Open it in a browser and press `m` to turn shared memory off: the fleet
goes back to paying for the same diagnosis over and over.

## Share fixes with your team

The memory lives inside `.git`, so a teammate's clone, or a cloud agent's, starts
without it. Fixes travel in a file you commit:

```sh
antibody export                  # write the fixes this fleet found to ANTIBODIES.md
git add ANTIBODIES.md && git commit -m "Share antibody fixes"
```

In another clone of the repository:

```sh
antibody import                  # read ANTIBODIES.md into this clone's memory
antibody review                  # read what came in
antibody allow --all             # or: antibody allow E-0004, antibody reject E-0005
```

A clone's first session runs the import on its own when the clone has no memory yet
and the repository commits `ANTIBODIES.md`, and tells its agent that a person must
review what came in. `ANTIBODY_AUTO_IMPORT=0` turns that off.

| Command | Does |
| --- | --- |
| `antibody export [--out FILE \| --print]` | Writes the fixes this fleet found to `ANTIBODIES.md` in the repository root, or to `FILE`, or prints them. It writes nothing when there is nothing to export, and never overwrites a file that is not an export |
| `antibody import [FILE] [--dry-run]` | Reads a file's fixes into this memory, held for review. `--dry-run` says what would be imported |
| `antibody review` | Prints everything that waits for review, in full |
| `antibody allow ID... \| --all` | Approves entries: agents see them from their next hook call |
| `antibody reject ID... \| --all` | Turns entries down: they move to `ANTIBODIES.archive.md`, and an import does not bring them back |
| `antibody relay serve [--port N] [--host H] [--data FILE]` | Runs a relay, below |
| `antibody relay sync` | Pushes this machine's fixes to the relay and pulls the others' |

**What leaves.** Only an entry with a working fix that was found in this repository.
Entries without a fix, `wontfix` entries and fixes still waiting for review stay
behind. Every text is redacted again, in case the file was edited by hand since, and
the notes are left out.

**What comes in is held back.** The file is text someone else wrote, so an imported
entry is held for review: agents are shown neither its fix nor its title, trigger or
sample. An agent that meets the same error is told "seen before, no fix recorded
yet", claims it and diagnoses it as usual. A fix an agent records itself is trusted
at once, because it was found in this fleet. Importing never replaces a fix this
memory already has, and never adds more entries than the memory has room for.
`antibody review` strips control, zero-width and direction-changing characters, and
the invisible tag characters that can hide text from a reader, from everything it
prints.

### Share through a relay

Cloud agents start in fresh containers, and a committed file only moves when someone
commits it. A relay moves fixes as they are found: a small HTTP service that every
machine's memory syncs through.

```sh
# Somewhere every agent can reach, behind a proxy that terminates TLS:
ANTIBODY_RELAY_TOKEN=<a long secret> antibody relay serve --host 0.0.0.0

# In each agent's environment:
ANTIBODY_RELAY=https://relay.example.com
ANTIBODY_RELAY_TOKEN=<the same secret>
ANTIBODY_RELAY_TRUST=fleet       # only when every machine with the token is yours
```

The agents' MCP server then syncs while it runs: as it starts, every 30 seconds, and
as it stops. Hooks never touch the network. `antibody relay sync` syncs by hand.

- **What the relay holds:** what export lets leave a machine, which is entries with
  a working fix, redacted again, without notes. It keeps the latest fix for each
  error, in one JSON file.
- **What comes back:** by default, what a machine pulls is held for review, as an
  import is. With `ANTIBODY_RELAY_TRUST=fleet`, every machine holding the token is
  trusted as one fleet, and an agent meeting the error is given the fix at once.
  Either way, a pulled fix never replaces one the machine has.
- **Limits:** the token must be 16 characters or more, a push is limited in size,
  and a relay holds at most 5,000 fixes. A machine sends only what changed since its
  last sync, and never pushes back what it pulled.

## Works with

| Agent | How antibody connects | Fix delivery |
| --- | --- | --- |
| Claude Code (works today) | Plugin: `PostToolUseFailure`, `PostToolUse`, `SessionStart`, `UserPromptSubmit` and `SessionEnd` hooks, plus an MCP server | Pushed through `additionalContext` |
| Gemini CLI (works today) | `antibody setup gemini`: `SessionStart`, `BeforeAgent`, `AfterTool` and `SessionEnd` hooks plus the MCP server in `~/.gemini/settings.json` | Pushed through `hookSpecificOutput.additionalContext` |
| Codex CLI (works today) | `antibody setup codex`: `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `SessionEnd` hooks in `~/.codex/hooks.json`, plus `codex mcp add` | Pushed through `hookSpecificOutput.additionalContext`; shell failures inferred from their output |
| Cursor, OpenCode, Aider and others | MCP server only | Pulled when the agent calls `antibody_lookup` |

The Gemini CLI and Codex CLI adapters were written against the payloads in each
CLI's own source (Gemini CLI 0.62.0, Codex CLI 0.160.1), and the end-to-end check
plays those payloads in every direction.

It works under any orchestrator, because it only needs the agents' own hooks:
herdr, vibe-kanban, superset, claude-squad, agent-orchestrator, paperclip, or plain
`git worktree add` and a few terminals. [Using antibody under an
orchestrator](docs/integrations.md) has a note on each.

## What works today

| Piece | Where | State |
| --- | --- | --- |
| Fingerprints: normalize an error, hash it to 12 characters | `src/signature.ts` | Built |
| Mandatory redaction of keys, tokens, e-mails and paths | `src/redact.ts` | Built |
| The `ANTIBODIES.md` entries document, safe under concurrent writers | `src/store.ts` | Built; also reads dsh-errkb's `ERRORS.md` |
| Matching: exact, fuzzy and by code | `src/match.ts` | Built |
| Capture: classifying failures, the noise rule | `src/capture.ts` | Built |
| Notices, their caps, fix trust and the injector | `src/notice.ts`, `src/trust.ts`, `src/injector.ts` | Built |
| Resolution detection | `src/resolve-detect.ts` | Built |
| Hit counters and trust records in `state.json` | `src/state.ts` | Built |
| The memory directory in the git common directory | `src/paths.ts` | Built |
| The `events.jsonl` event log | `src/events.ts` | Built |
| Claims, so only one agent diagnoses a new error | `src/claims.ts` | Built |
| The fleet loop: claims, claim hints, held fixes, trust and per-session caps per hook call | `src/fleet.ts`, `src/session.ts` | Built |
| The Claude Code adapter and the `antibody` command line | `src/claude-code.ts`, `src/cli.ts`, `dist/antibody.mjs` | Built |
| The five agent tools and the MCP server | `src/tools.ts`, `src/mcp.ts` | Built |
| The Claude Code plugin | `.claude-plugin/`, `hooks/hooks.json` | Built; validated with `claude plugin validate` |
| The Gemini CLI and Codex CLI adapters | `src/gemini.ts`, `src/codex.ts`, `src/hook-input.ts` | Built; payloads read off each CLI's source |
| `antibody setup` for Gemini CLI and Codex CLI | `src/setup.ts` | Built |
| `antibody watch` and `antibody stats` | `src/watch.ts`, `src/watch-model.ts`, `src/watch-render.ts`, `src/cli.ts` | Built |
| `antibody export`, `import`, `review`, `allow` and `reject`, and the review gate | `src/exchange.ts`, `src/exchange-cli.ts`, `src/review.ts`, `src/review-cli.ts`, `src/memory-cli.ts` | Built |
| The diagnosis cost, read from Claude Code, Codex CLI and Gemini CLI transcripts | `src/transcript.ts`, `src/fleet.ts`, `src/tools.ts` | Built |
| The benchmark: traps, tasks, the on and off runner, scripted and Claude Code agents | `bench/` | Built; no real run published yet |
| Import of a committed export on a clone's first session | `src/auto-import.ts` | Built |
| The relay, `antibody relay serve` and `sync`, and the MCP server's background sync | `src/relay.ts`, `src/relay-server.ts`, `src/relay-client.ts`, `src/relay-cli.ts` | Built |

## Built on dsh-errkb

antibody's core came from [dsh-errkb](https://github.com/jingchangzhao-gif/dsh-errkb),
an error knowledge base for a single DeepSeek Harness agent. Its pure layer
(fingerprinting, redaction, the markdown store, matching, capture, notices, fix trust,
state and resolution detection) came over with its tests and keeps its MIT notice in
[`NOTICE`](NOTICE). antibody replaced the single-harness wiring with what a fleet needs:
the shared memory directory, the event log and claims.

## Development

Node 22.13 or newer and pnpm 11.

```sh
pnpm install
pnpm test            # vitest with the 99% statements and lines gate
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run build       # lib/ and the dist/antibody.mjs bundle, via tsdown
pnpm run e2e         # the M2 exchange end to end, plus hook latency
pnpm run bench       # the benchmark; see bench/README.md
```

`dist/antibody.mjs` is committed, because Claude Code runs the plugin straight from
git. CI fails when a source change is pushed without the rebuilt bundle.

CI runs all of these on every push and pull request, plus a privacy guard that rejects
personal paths, private e-mail addresses and credential-shaped tokens. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## Documents

- [Design](docs/design.md): how capture, claims, storage, injection and the fleet view work, plus failure modes and open questions
- [Landscape](docs/landscape.md): the October 2026 survey of about 40 multi-agent and agent-memory projects, and the gaps it found
- [Roadmap](docs/roadmap.md): milestones from the core port to a published benchmark
- [Integrations](docs/integrations.md): using antibody under herdr, vibe-kanban, superset, claude-squad, agent-orchestrator and paperclip

## License

[MIT](LICENSE). Code ported from dsh-errkb keeps its own MIT notice; see [`NOTICE`](NOTICE).
