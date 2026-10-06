# Using antibody under an orchestrator

antibody does not start agents. It rides on each agent's own hooks, so it works under
any orchestrator that runs Claude Code, Codex CLI or Gemini CLI, and under plain
`git worktree add` and a few terminals. These notes say, for six orchestrators, how
they lay out their agents' work and what that means for antibody.

They were written from each project's own README in October 2026. The projects move
quickly, so check their documentation for anything that has changed since.

## What decides it

One question decides what you need to do: **do the agents work in worktrees of one
repository, or on separate machines?**

- **Worktrees of one repository.** antibody keeps its memory in the repository's git
  common directory (`.git/antibody`), which every linked worktree shares. Install
  antibody in each harness once, and every agent the orchestrator starts in a
  worktree shares fixes with the others. There is nothing to configure in the
  orchestrator.
- **Separate clones, containers or cloud sandboxes.** Each has its own `.git`, so each
  has its own memory. Share between them in one of two ways:
  - **Commit an export.** `antibody export` writes the fixes your fleet found to
    `ANTIBODIES.md`. Commit it, and a fresh clone's first session imports it on its
    own, held until a person approves it with `antibody review` and `antibody allow`.
  - **Run a relay.** Start `antibody relay serve` somewhere every machine can reach,
    and give each agent's environment `ANTIBODY_RELAY` (the relay's URL) and
    `ANTIBODY_RELAY_TOKEN`. The agents' MCP server then syncs every 30 seconds. Set
    `ANTIBODY_RELAY_TRUST=fleet` when every machine with the token is yours;
    otherwise what comes in waits for a person's review.

### Install once per harness

| Harness | Install |
| --- | --- |
| Claude Code | `/plugin marketplace add Shyboy0499/antibody`, then `/plugin install antibody@antibody` |
| Gemini CLI | `antibody setup gemini` |
| Codex CLI | `antibody setup codex` |
| Any MCP agent | add `node <path>/dist/antibody.mjs mcp` as an MCP server; it can then look fixes up and record them, but nothing is pushed to it |

These are settings of the harness, not of the orchestrator, so every session the
orchestrator starts picks them up.

### Names in the fleet view

antibody names each agent after its harness and its worktree folder, for example
`claude-code@agent-3`, so agents in different worktrees already have different
names. An orchestrator that knows better names can set `ANTIBODY_AGENT` in each
agent's environment.

Run `antibody watch` in any worktree of the repository, in a spare pane or terminal,
to see the whole fleet.

## The orchestrators

### claude-squad

claude-squad gives each session its own git worktree, on its own branch, and runs
`claude` in it by default. `-p`/`--program`, or `default_program` and `profiles` in
`~/.claude-squad/config.json`, choose another program, such as `codex` or `aider`.

- **Layout:** worktrees of one repository, so the sessions share antibody's memory
  as they are.
- **To do:** install antibody in each harness you run. An `aider` profile can use
  only the MCP tools.

### vibe-kanban

vibe-kanban gives each task a workspace with its own branch, terminal and dev server,
and runs one of its supported agents in it, among them Claude Code, Codex and Gemini
CLI. Its README describes cleaning up the worktrees behind those workspaces
(`DISABLE_WORKTREE_CLEANUP`).

- **Layout:** worktrees of one repository, so tasks share antibody's memory.
- **To do:** install antibody in the harnesses its tasks run. A task's setup needs no
  antibody step.
- **Note:** a task's worktree may be removed when the task is cleaned up. antibody's
  memory is in the main repository's `.git`, not in the worktree, so it outlives the
  task.

### superset

superset gives each task a git worktree with its own branch and terminals, and runs
any CLI agent in it. `.superset/config.json` holds each workspace's setup, teardown
and run scripts, and Settings → Agents holds each agent's launch command.

- **Layout:** worktrees of one repository, so agents share antibody's memory.
- **To do:** install antibody in the harnesses you launch. The workspace setup script
  needs no antibody step. Where a launch command can set environment variables,
  `ANTIBODY_AGENT` gives the agent the name the fleet view shows.

### agent-orchestrator

agent-orchestrator gives each worker its own branch and worktree for work in a git
repository, and branchless directories that it manages for agents without one. It
runs many harnesses, among them Claude Code, Codex and Gemini CLI.

- **Layout:** worktrees of one repository for repository work, so workers share
  antibody's memory.
- **To do:** install antibody in the harnesses it runs. Agents in its branchless
  directories have no repository, and antibody stays silent there.

### herdr

herdr is a runtime that keeps agents' terminals alive in a background server. It owns
their terminals and does not wrap the agents. Agents drive it through its command line
and socket API.

- **Layout:** wherever you start each agent. Start them in worktrees of one
  repository (`git worktree add`) and they share antibody's memory.
- **To do:** install antibody in the harnesses you run in herdr's panes. A pane
  running `antibody watch` shows the fleet.

### paperclip

paperclip runs agents through adapters, among them Claude Code, Codex and Gemini CLI,
in project workspaces with optional isolated execution workspaces (git worktrees),
and can run them beyond the local machine through sandbox providers.

- **Layout:** agents in one repository's workspaces and worktrees share antibody's
  memory. Agents in remote sandboxes each have their own.
- **To do:** install antibody in the harnesses its adapters run. For sandboxed
  agents, commit an export or run a relay, and give them `ANTIBODY_RELAY` and
  `ANTIBODY_RELAY_TOKEN` through the secrets paperclip injects.
