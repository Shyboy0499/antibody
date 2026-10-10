# The benchmark

Does antibody save a fleet tokens and time? The benchmark runs the same fleet on the
same tasks twice: once with antibody's injection on, and once with it off. Then it
counts the difference.

## What a run does

**The project.** [`fixture/`](fixture) is a small shop service. A fresh worktree of
it meets four errors from the design's table (§2), one at a time, before its tests
pass:

| Trap | Error | Fix | Why every worktree meets it |
| --- | --- | --- | --- |
| `lockfile` | `ERR_PNPM_OUTDATED_LOCKFILE` | `npm run lock` | `deps.lock` is out of date with `package.json` |
| `env` | `Environment variable not found: DATABASE_URL.` | copy `.env.example` to `.env` | worktrees do not get untracked files |
| `generated` | `Cannot find module '…/generated/client.js'` | `npm run generate` | generated code is not committed |
| `port` | `EADDRINUSE …:4817` | `PORT=0` in `.env` | the runner keeps the port busy, like a neighbour's dev server |

Each fix has to be applied in each worktree. Knowing the fix is what one agent can
give the others. [`traps.ts`](traps.ts) says how to recognise each trap.

**The tasks.** [`tasks.ts`](tasks.ts) holds eight ordinary tasks: two bugs, a new
endpoint and five small functions. Each ends with "make sure `npm test` passes",
which is how every agent meets the traps. Each task has a hidden acceptance check
in [`checks/`](checks), run in the agent's worktree afterwards. Agents never see the
checks.

**A run.**

1. The runner commits the project in a fresh repository under the system's temporary
   folder and adds a worktree per agent.
2. It holds the project's port.
3. It starts every agent at once, each on its own task, and waits for them all.

**The arms.**

| | Injection on | Injection off |
| --- | --- | --- |
| antibody's hooks | installed, as its plugin installs them | installed, silent: the memory is paused |
| antibody's MCP server | installed | not installed |

In both arms the hooks record every failure, so both are measured the same way.
Runs alternate which arm goes first.

**What is counted, per run:**

- **Tokens:** what the fleet's models newly read or wrote, from each agent's
  transcript. That is input, cache writes and output. It is the same measure
  antibody uses for a diagnosis.
- **Fleet wall time:** from the start until the slowest agent is done.
- **Trap diagnoses:** for each trap, the agents that met it and got past it without
  a fix notice reaching them first.
- **Repeat diagnoses:** the trap diagnoses beyond the first of each trap. This is
  the waste antibody exists to remove (design §2).
- **Tasks done:** tasks whose hidden check passes.
- **Coverage:** which of the traps an agent met after running a command with a pipe in
  its session, read from the agent's transcript ([`coverage.ts`](coverage.ts)). The memory
  says the traps were met; the transcripts say which commands they came through, which is
  what tells a run that measured piped commands from one that did not (#131).

The results table shows each arm's median run. A run a session failed in - a Claude Code
turn that stopped on an API error or a usage limit, say - is **left out** rather than scored:
almost no tokens and nothing done is a statement about the failure, not about the fleet. The
table counts what it left out and why underneath itself.

## Run it

Build the bundle first, because the agents' hooks call `dist/antibody.mjs`:

```sh
pnpm run build
```

**Scripted agents** cost nothing and take about a minute:

```sh
pnpm run bench -- --agents 8 --runs 3 --speed 0.05 --record fixed
```

A scripted agent ([`fake-agent.ts`](fake-agent.ts)) goes through antibody's real
hooks and MCP server.

- Its knowledge of each fix stands in for reasoning.
- Fixed costs per step stand in for what reasoning takes.
- With `--record fixed`, it records a fix as soon as the fix works.
- By default it records only when antibody asks.
- With `--pipe`, it runs the tests the way real agents do - `npm test 2>&1 | tail -60`,
  in a shell - and asks the plugin's PreToolUse hook what to run before each call, as the
  client does. A pipeline reports its last command's status, so this is the shape #131 is
  about: unless the rewrite made the shell report a failure, the hook has only the output to
  go on. `ANTIBODY_BENCH_SHELL` names the shell, for a machine whose `bash` is not the one
  that can run the project (Windows, and a `bash` on PATH that is a WSL without a
  distribution).

Its numbers check the runner and show antibody's protocol at work. **They are not a
result about real agents.**

**Claude Code agents cost money:**

```sh
pnpm run bench -- --agent claude --max-budget-usd 2 --agents 8 --runs 3
```

- **One session each.** Every agent is a full `claude -p` session. That is
  8 agents × 2 arms × 3 runs = 48 sessions here. Each is capped at
  `--max-budget-usd`, and the runner prints the worst case before it starts.
- **You need `claude` installed and logged in.**
- **Permissions are skipped.** Agents run with `--dangerously-skip-permissions`,
  inside throwaway worktrees under the temporary folder.
- **Your own setup stays out.** Only the project's settings are read, and only
  antibody's MCP server is loaded. Your own plugins, hooks and MCP servers are not.
- **Transcripts are kept.** They are written where Claude Code keeps sessions
  (`CLAUDE_CONFIG_DIR`, or `~/.claude`). The runner keeps a copy with the results.
- **A usage limit stops the schedule.** A session that a limit stopped is not a
  measurement, so its run is left out, and the runner stops there rather than pay for the
  rest of the runs. It prints what is left and the command that finishes it:
  `--resume bench/results/<time>` keeps the runs already done and runs only the rest.
  `--keep-going` finishes the schedule anyway.

| Option | Default | |
| --- | --- | --- |
| `--agent fake\|claude` | `fake` | the kind of agent |
| `--agents N` | 8 | agents per run, one task each |
| `--runs N` | 3 | runs per arm |
| `--arms on,off` | both | which arms to run |
| `--out DIR` | `bench/results/<time>` | where the results go |
| `--resume DIR` | | carry on from a results directory: its runs are kept |
| `--keep-going` | | finish the schedule after a usage limit stopped a run |
| `--publish DIR` | | also publish the results there, without this machine's paths |
| `--timeout-min N` | 30 | when an agent is given up on and stopped |
| `--keep` | | keep each run's workspace to look at |
| `--port N` | 4817 | the project's port, which each run keeps busy |
| `--speed X` | 1 | scripted: multiplies its pretend durations |
| `--record asked\|fixed` | `asked` | scripted: when it records a fix |
| `--patience-ms N` | 30000 × speed | scripted: how long it waits for a peer's fix |
| `--pipe` | | scripted: run the tests through a pipe, as real agents do (#131) |
| `--max-budget-usd X` | required | Claude Code: each agent's cap in dollars |
| `--model NAME` | claude's default | Claude Code: the model |
| `--claude-bin PATH` | `claude` | Claude Code: the command |

## The results

Results go to `bench/results/<time>/`, which git ignores until results are published:

- `results.md`: the table, a line saying what injection changed, and what was left out;
- `results.json`: every run's summary, each with `invalid` and, when it is, why;
- `run-<n>-<arm>/summary.json`: the run, agent by agent, with any error, and its coverage;
- `run-<n>-<arm>/<session>.jsonl`: each agent's transcript. For Claude Code there is
  also `<session>.out.json`, which records its cost and turns.

**Publishing.** `--publish bench/published/<date>` writes the directory a commit can hold
([`publish.ts`](publish.ts)):

```sh
pnpm run bench -- --agent claude --max-budget-usd 1 --agents 8 --runs 3 \
  --publish bench/published/2026-10-10
```

- `results.md` and `results.json`, copied as they are;
- `run-<n>-<arm>/summary.json`, one per run;
- `environment.md`: the command to rerun, the fleet, the schedule, each agent's cap, the
  antibody commit, the node version and when it was published;
- `coverage.md`: what each run's traps came through, from [`coverage.ts`](coverage.ts).

The transcripts, the client's output files and the kept workspaces are **never** published:
they name paths on this machine, and the repository's privacy guard rejects those. The
coverage report says "unknown" for a run whose transcripts hold no command at all, rather
than claiming it met nothing through a pipe. A scripted run holds the calls its agent made,
so it reports `0 piped` until it is run with `--pipe`.

## Adding a kind of agent

A driver ([`drivers.ts`](drivers.ts)) starts one agent in its worktree. It runs the
agent until it exits and says what its tokens were. The runner times the agent and
checks its work. [`claude.ts`](claude.ts) is the example to follow.
