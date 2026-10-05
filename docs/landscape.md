# Landscape

A survey of the multi-agent and agent-memory projects on GitHub, taken on
5 October 2026. Star counts come from GitHub search and the trending pages that day,
so treat them as a snapshot.

## What is trending

The trending pages for the day, the week and the month were dominated by four
themes:

1. **Agent memory that learns.** vectorize-io/hindsight (45.5k stars, +23.2k this
   month) and thedotmack/claude-mem (96.1k).
2. **Agent output you can look at.** tt-a1i/archify (77.5k, +30.2k this month) turns
   codebases into interactive diagrams; heygen-com/hyperframes (56.8k) renders HTML
   into video.
3. **Running many agents.** paperclipai/paperclip (97.2k, +17.4k this month),
   mvschwarz/openrig (5.0k, +4.3k this week), NVIDIA/OpenShell (14.9k),
   max-sixty/worktrunk (8.8k).
4. **One-file skills with a sharp premise.** DietrichGebert/ponytail (154.9k) and
   ayghri/i-have-adhd (53.6k).

## The multi-agent field

There are well over a hundred orchestrators. andyrewlee/awesome-agent-orchestrators
lists 24 terminal tools, 61 desktop and web apps, 28 swarm frameworks, 29
infrastructure projects and more. The notable ones fall into a few groups.

**Agent offices and companies**

| Project | Stars | Pitch |
| --- | ---: | --- |
| paperclipai/paperclip | 97.2k | Org charts, tickets, budgets and approvals for teams of agents |
| HarnessMD/munder-difflin | 8.4k | An office of Claude Code and Codex agents on your laptop |
| mvschwarz/openrig | 5.0k | Persistent agent teams with roles and shared context |
| MaxMiksa/Auto-Company | 3.1k | An autonomous company running 24/7 |
| 777genius/agent-teams-ai | 2.2k | Agents message and review each other on a kanban board |
| yohey-w/multi-agent-shogun | 1.4k | A samurai hierarchy of Claude Code agents in tmux |

**Desktop and web control planes**

| Project | Stars | Pitch |
| --- | ---: | --- |
| BloopAI/vibe-kanban | 28.3k | Kanban board, a workspace per task, review and PRs |
| superset-sh/superset | 14.9k | IDE for running 100+ agents in parallel worktrees |
| Untrivial-ai/agent-orchestrator | 12.7k | Plans work, spawns agents, fixes CI, any harness |
| builderz-labs/mission-control | 6.3k | Dispatch tasks, review runs, track spend |
| golutra/golutra | 3.9k | Unified desktop for Codex, Claude Code and OpenClaw |
| xintaofei/codeg | 3.8k | Aggregates sessions from many agents |
| tutti-os/tutti | 3.8k | Shared workspace for people and agents |
| stravu/crystal (now Nimbalyst) | 3.1k | Parallel sessions in worktrees, compare approaches |

**Terminal runtimes and multiplexers**

| Project | Stars | Pitch |
| --- | ---: | --- |
| herdrdev/herdr | 42.3k | The runtime coding agents live on, sessions survive reboot |
| max-sixty/worktrunk | 8.8k | Git worktree management for parallel agents |
| smtg-ai/claude-squad | 8.6k | Manage several terminal agents |
| eneskirca/nodeterm | 2.0k | Agent terminals as nodes on a canvas |
| devflowinc/uzi | 0.6k | Many agents in parallel worktrees |
| mixpeek/amux | 0.5k | Control plane with a shared board, single Rust binary |

**Swarm frameworks and meta-harnesses**

| Project | Stars | Pitch |
| --- | ---: | --- |
| ruvnet/ruflo | 73.9k | Swarms with adaptive memory and federation |
| omnigent-ai/omnigent | 10.5k | Meta-harness with policies and sandboxing |
| open-multi-agent/open-multi-agent | 7.0k | Runtime with durable approvals and run records |
| loopx-project/loopx | 6.2k | Control plane with a durable state kernel |
| the-open-engine/zeroshot | 1.9k | Implement, review, repair as a graph until checks pass |
| nrslib/takt | 1.4k | Coordination topology in YAML |

**Messaging between agents**

| Project | Stars | Pitch |
| --- | ---: | --- |
| fujibee/agmsg | 1.5k | Claude Code, Codex, Gemini and Copilot talk to each other, Bash and SQLite |
| ChesterRa/cccc | 1.3k | Agents coordinate like a group chat |

## Agent memory

| Project | Stars | Scope |
| --- | ---: | --- |
| thedotmack/claude-mem | 96.1k | One agent's sessions, captured by hooks, summarized, stored in SQLite and Chroma, injected later |
| vectorize-io/hindsight | 45.5k | General memory infrastructure: facts, experiences, mental models, four retrieval strategies |
| rohitg00/pro-workflow | 2.9k | Claude Code learns from one user's corrections |
| SethGammon/Citadel | 0.9k | Operating layer with project memory, routing, safety hooks and fleets |
| Noelune/unified-agent-memory | 7 | Shared Obsidian vault for several harnesses |
| muslewski/memory-atlas | 4 | Code-verified memory for agent fleets |
| sam-ent/fleet-mem | 3 | Shared code search and memory for fleets |
| kyletusing34/agent-nerve | 3 | Shared operational memory for mixed fleets |

## Gaps

From the awesome-list's categories and targeted searches:

- **Learning shared across a running fleet: open.** Searches for agents learning from
  each other, cross-agent knowledge sharing and shared memory across parallel agents
  returned nothing. The fleet-memory projects that exist have single-digit stars, and
  the large memory projects serve one agent or one user.
- **Cost control: mostly covered by the leader.** paperclip has budgets and
  enforcement. Few other tools do.
- **Best-of-N selection: thin, but taken.** bakeoff-dev/bakeoff ("Race coding agents
  on your real issues. Merge the winner.") already ships hidden tests, tamper
  detection, scoring and a live view, at 1 star. mco-org/mco (531 stars) compares
  agents' answers but leaves the decision to a person.
- **Merge conflicts between worktrees: small tools.** clash-sh/clash (65 stars),
  Nithinfgs/mergecast, AlexisBalayre/pupitre and Vignesh-P-C/DriftWatch, all under 100
  stars.

## Where antibody fits

antibody takes the first gap, and takes it in a way that does not compete with the
orchestrators:

- **It sits underneath them.** Every orchestrator above can run agents with antibody
  installed, so their users are antibody's users rather than its competitors' users.
- **It needs no agent cooperation.** agmsg and cccc let agents talk, but the agents
  have to choose to talk. antibody captures through hooks, so a fix moves even when
  no agent thought to share it.
- **It is narrow and measurable.** claude-mem and hindsight remember everything for one
  agent. antibody remembers errors for many agents, and every injection has a token
  cost and an estimated saving, so its value shows up as a number.
- **It handles in-flight duplicates.** Claims stop two agents from diagnosing the same
  new error at the same moment. Single-agent memory has no such case.
- **It starts from tested code.** dsh-errkb's pure layer gives it fingerprinting,
  redaction, a markdown store, matching and fix trust on day one.

## Considered and not chosen

- **Agent race (best-of-N with tests).** Very demo-friendly, but bakeoff-dev/bakeoff
  already implements the core loop.
- **Merge-conflict radar.** Useful, but several small tools exist, and it is less
  distinctive.
- **Fleet budget governor.** paperclip already covers budgets for its users.
