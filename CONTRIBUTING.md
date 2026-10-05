# Contributing to antibody

antibody is early. Milestone M1, the core and the shared memory, is built and tested;
nothing connects to an agent yet. Fixes, tests, a review of the design, or
disagreement with it are all welcome while decisions are still cheap to change.

## Before you push

Node 22.13 or newer and pnpm 11.

```sh
pnpm install
pnpm test            # fails under 99% statements or lines
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run build
```

CI runs the same five checks on every pull request, plus a privacy guard that rejects
absolute personal paths, personal e-mail addresses and credential-shaped tokens
anywhere in the tree. Write placeholders such as `<path>` or `<repo-root>` instead,
and assemble credential-shaped test inputs at run time, as the redaction tests do.

## How the code is organised

- **`docs/design.md` describes how antibody should behave.** If the code and the
  design disagree, one of them has a bug: fix the code, or update the design in the
  same pull request.
- **Machines are injected.** Modules that touch the disk take their filesystem and
  clock as arguments (`StoreFs`, `StoreClock`), so locking, staleness and corruption
  are tested without racing a real disk. Anything that must hold up under
  concurrency also gets a real-filesystem test; `tests/concurrency.test.ts` runs
  eight separate processes.
- **Ported code says where it came from.** Files taken from dsh-errkb start with a
  comment naming their source and pointing at `NOTICE`. Keep that comment when you
  edit such a file, and add one to anything else you bring over.
- **Hooks fail open.** Code that will run inside an agent's hook must never block or
  break the agent: on an internal error it says nothing.

## Pull requests

- One change per pull request, small enough to review in one sitting.
- Say what changed and why; the template has a short checklist.
- Commit subjects are short and imperative ("Add claims", "Port matching"), with a
  body that says why.
