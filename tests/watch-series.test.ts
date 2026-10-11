import { describe, expect, it } from "vitest";
import type { MemoryEvent } from "../src/events";
import { SERIES_POINTS, savedSeries } from "../src/watch-model";

const NOW = new Date("2026-10-05T10:00:00.000Z");
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
// A fix notice ("hit" is one of the fix notice kinds) for E-0001.
const notice = (msAgo: number, tokens: number): MemoryEvent => ({
  v: 1,
  t: at(msAgo),
  kind: "notice",
  agent: "b",
  session: "s-b",
  id: "E-0001",
  notice: "hit",
  tokens,
});

describe("savedSeries", () => {
  it("is all zeros with no events", () => {
    expect(savedSeries([], new Map(), NOW)).toEqual(
      Array.from({ length: SERIES_POINTS }, () => 0),
    );
  });

  it("ends on the memory pane's figure: each fix's diagnosis less every notice's tokens", () => {
    const costs = new Map([["E-0001", 1000]]);
    // Two fixes at 1000 each, and 300 tokens of notices.
    const series = savedSeries(
      [notice(9_000, 100), notice(1_000, 200)],
      costs,
      NOW,
    );
    expect(series).toHaveLength(SERIES_POINTS);
    expect(series.at(-1)).toBe(1700);
  });

  it("climbs as the fixes happen, and sits flat between them", () => {
    const costs = new Map([["E-0001", 1000]]);
    const series = savedSeries([notice(9_000, 0), notice(0, 0)], costs, NOW);
    expect(series[0]).toBe(1000);
    expect(series.at(-1)).toBe(2000);
    expect(series).toContain(1000);
    expect(series).toEqual([...series].sort((a, b) => a - b));
  });

  it("never goes below zero when notices cost more than the fixes saved", () => {
    const costs = new Map([["E-0001", 100]]);
    const series = savedSeries([notice(5_000, 900)], costs, NOW);
    expect(series.every((v) => v >= 0)).toBe(true);
    expect(series.at(-1)).toBe(0);
  });
});
