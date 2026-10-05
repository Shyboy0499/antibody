# ERRORS (seed entries)

Curated entries for errors that fleets of parallel agents meet in fresh git
worktrees. They contain no machine names, project names, paths or credentials,
and tests/redact.test.ts fails if redaction would change a single character
here.

The file is written by `renderEntry` in src/store.ts with English labels, and
tests/seeds.test.ts checks that it still is. Nothing copies these entries into
shared memory yet.

## E-0001 · [tool:bash] ENV_NOT_FOUND: an untracked .env is missing from a fresh worktree
<!-- errkb: sig=608db4a994fb cat=tool code=ENV_NOT_FOUND first=2026-10-05T00:00:00Z -->

- Fingerprint: `608db4a994fb`
- Category: `tool / bash`
- First seen: 2026-10-05 00:00 · Last seen: 2026-10-05 00:00 · Hits: 0
- Trigger: Running the app or its tests in a worktree just created with `git worktree add`
- Raw message:
  ```text
  PrismaClientInitializationError: Environment variable not found: DATABASE_URL.
  ```
- Fix:
  `git worktree add` checks out tracked files only, so `.env` and every other untracked file the app reads at startup are missing.
  Copy them from the main checkout into this worktree, or have whatever creates the worktrees copy them every time.
- Status: `fixed`
- Notes:
  Seed entry. The variable name varies; the cause is the same for any setting read from an untracked file.

## E-0002 · [tool:bash] EADDRINUSE: another agent's dev server holds the port
<!-- errkb: sig=d9d412c44898 cat=tool code=EADDRINUSE first=2026-10-05T00:00:00Z -->

- Fingerprint: `d9d412c44898`
- Category: `tool / bash`
- First seen: 2026-10-05 00:00 · Last seen: 2026-10-05 00:00 · Hits: 0
- Trigger: Several agents start the dev server or an end-to-end test run at the same time
- Raw message:
  ```text
  Error: listen EADDRINUSE: address already in use :::3000
  ```
- Fix:
  Parallel agents all reach for the same default port. Do not kill the process that holds it: it belongs to another agent.
  Start this server on a free port instead (`PORT=0` lets the system pick one where the server supports it, or use the port assigned to this worktree), and read the real port from its startup output.
- Status: `fixed`
- Notes:
  Seed entry. The port number is replaced by a placeholder when fingerprinting, so every port matches this entry.

## E-0003 · [tool:git] WORKTREE_BRANCH: the branch is already checked out in another worktree
<!-- errkb: sig=73acec6e8980 cat=tool code=WORKTREE_BRANCH first=2026-10-05T00:00:00Z -->

- Fingerprint: `73acec6e8980`
- Category: `tool / git`
- First seen: 2026-10-05 00:00 · Last seen: 2026-10-05 00:00 · Hits: 0
- Trigger: Switching a worktree to a branch that another agent's worktree has checked out
- Raw message:
  ```text
  fatal: 'main' is already checked out at '<path>'
  ```
- Fix:
  Git lets a branch be checked out in only one worktree at a time.
  Create a branch for this task and work there: `git switch -c <task-branch>`. Compare with the shared branch through `git log` or `git diff` instead of checking it out.
- Status: `fixed`
- Notes:
  Seed entry.
