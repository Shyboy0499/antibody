import { describe, expect, it } from "vitest";
import type { AntibodyRow, FleetView } from "../src/watch-model";
import { renderView, sparkline } from "../src/watch-render";
import type { RenderOptions } from "../src/watch-render";

const NOW = new Date("2026-10-05T10:00:00.000Z");

const antibody = (
  id: string,
  extra: Partial<AntibodyRow> = {},
): AntibodyRow => ({
  id,
  fingerprint: "00000000abcd",
  category: "tool / sh",
  title: `[tool] ${id} failed`,
  status: "open",
  fix: "",
  reused: 0,
  saved: 0,
  ...extra,
});

const view: FleetView = {
  agents: [],
  memory: {
    tokensSaved: 0,
    noticeTokens: 0,
    avoided: 0,
    antibodies: 1,
    measured: 0,
    entries: 2,
    open: 1,
    immunity: 0,
    held: 0,
  },
  antibodies: [
    antibody("E-0001"),
    antibody("E-0002", {
      fix: "bump the port",
      beatenBy: "codex@x",
      reused: 3,
      saved: 900,
    }),
  ],
  events: [],
  saved: Array.from({ length: 24 }, (_, i) => i * 10),
};

const options = (o: Partial<RenderOptions> = {}): RenderOptions => ({
  width: 100,
  height: 24,
  color: false,
  now: NOW,
  repo: "antibody",
  timeZone: "UTC",
  ...o,
});

const text = (lines: string[]) => lines.join("\n");

describe("sparkline", () => {
  it("draws one block per point, scaled to the highest", () => {
    expect(sparkline([0, 4, 8])).toBe("▁▅█");
    expect(sparkline([0, 0, 0])).toBe("▁▁▁");
    expect(sparkline([])).toBe("");
  });
});

describe("the watch screen's additions", () => {
  it("names the branch in the status line", () => {
    const lines = renderView(view, options({ branch: "feat/x", width: 160 }));
    expect(lines[0]).toContain("antibody · feat/x");
  });

  it("draws the tokens-saved sparkline under the memory figures", () => {
    const screen = text(renderView(view, options()));
    expect(screen).toContain("tokens saved over time");
    expect(screen).toContain(sparkline(view.saved));
  });

  it("marks the selected antibody", () => {
    const screen = text(renderView(view, options({ selected: 1 })));
    expect(screen).toContain("›E-0002");
    expect(screen).not.toContain("›E-0001");
  });

  it("shows the selected antibody's detail in place of the events", () => {
    const screen = text(
      renderView(view, options({ selected: 1, detail: view.antibodies[1] })),
    );
    expect(screen).toContain("Antibody E-0002");
    expect(screen).toContain("bump the port");
    expect(screen).toContain("codex@x");
    expect(screen).toContain("3 times");
    expect(screen).not.toContain("Events");
    expect(screen).toContain("enter close");
  });

  it("keeps the events pane when no detail is open", () => {
    const screen = text(renderView(view, options({ selected: 1 })));
    expect(screen).not.toContain("Antibody E-0002");
    expect(screen).toContain("Events");
  });
});
