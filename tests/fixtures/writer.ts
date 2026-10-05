// One agent of the eight-writer test (tests/concurrency.test.ts), run in its
// own process. Without pausing, each round it does what a busy agent does to
// shared memory: contends for a claim on one shared entry, records a new entry
// of its own, bumps the shared entry's hit counter, appends an event, and
// releases the claim if it won it.
import { createClaimsFile } from "../../src/claims";
import { appendEvent } from "../../src/events";
import { filesIn } from "../../src/paths";
import { signature } from "../../src/signature";
import { createStateFile } from "../../src/state";
import { createStore } from "../../src/store";

const dir = process.env.ANTIBODY_TEST_MEMORY as string;
const agent = process.env.ANTIBODY_TEST_AGENT as string;
const rounds = Number(process.env.ANTIBODY_TEST_ROUNDS);
const SHARED = "E-shared";

const files = filesIn(dir);
const store = createStore(files, { lockTimeoutMs: 30_000 });
const state = createStateFile(files, { lockTimeoutMs: 30_000 });
const claims = createClaimsFile(files, { lockTimeoutMs: 30_000 });

let granted = 0;
for (let round = 0; round < rounds; round++) {
  const outcome = await claims.claim({ id: SHARED, agent, session: agent });
  if (outcome.granted) granted++;

  const raw = `${agent} failed in round ${round}: connect ECONNREFUSED`;
  const { id } = await store.append({
    title: `[tool:bash] ${agent} round ${round}`,
    signature: signature("tool", raw),
    category: "tool / bash",
    meta: { cat: "tool", code: "TEST" },
    raw,
  });

  await state.update((s) => {
    const counter = s.entries[SHARED] ?? {
      hits: 0,
      lastSeen: "2026-10-05 06:00",
    };
    counter.hits++;
    s.entries[SHARED] = counter;
  });

  await appendEvent(files.events, { kind: "miss", agent, session: agent, id });

  if (outcome.granted) await claims.release(SHARED, agent);
}

process.stdout.write(JSON.stringify({ agent, granted }));
