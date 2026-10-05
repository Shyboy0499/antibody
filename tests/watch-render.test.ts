import { describe, expect, it } from "vitest";
import { cells, fit, renderView } from "../src/watch-render";
import type { RenderOptions } from "../src/watch-render";
import type { FleetView } from "../src/watch-model";

const NOW = new Date("2026-10-05T10:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (line: string) => line.replace(ANSI, "");

const view: FleetView = {
  agents: [
    {
      agent: "claude-code@wt-a",
      state: "diagnosing",
      id: "E-0003",
      since: ago(130),
      lastSeen: ago(5),
    },
    {
      agent: "codex@wt-c",
      state: "immune",
      id: "E-0001",
      saved: 740,
      lastSeen: ago(20),
    },
    {
      agent: "gemini@wt-b",
      state: "holding",
      id: "E-0003",
      holder: "claude-code@wt-a",
      lastSeen: ago(30),
    },
    { agent: "claude-code@wt-d", state: "working", lastSeen: ago(12) },
  ],
  memory: {
    tokensSaved: 1350,
    noticeTokens: 250,
    avoided: 2,
    antibodies: 1,
    entries: 3,
    open: 2,
    immunity: 1,
  },
  antibodies: [
    {
      id: "E-0001",
      fingerprint: "a",
      category: "c",
      title: "[command-exit:Bash] pnpm dev → Error: missing .env",
      status: "fixed",
      fix: "Copy .env from the main checkout.",
      beatenBy: "claude-code@wt-a",
      reused: 2,
      saved: 1380,
    },
    {
      id: "E-0002",
      fingerprint: "b",
      category: "c",
      title: "[tool:Read] ENOENT: 设定文件不存在",
      status: "wontfix",
      fix: "",
      reused: 0,
      saved: 0,
    },
    {
      id: "E-0003",
      fingerprint: "c",
      category: "c",
      title: "[command-exit:Bash] pnpm test → port 3000 in use",
      status: "open",
      fix: "",
      diagnosing: "claude-code@wt-a",
      reused: 0,
      saved: 0,
    },
  ],
  events: [
    {
      t: ago(130),
      agent: "claude-code@wt-a",
      id: "E-0003",
      tag: "new",
      text: "port 3000 in use",
    },
    {
      t: ago(30),
      agent: "gemini@wt-b",
      id: "E-0003",
      tag: "holding",
      text: "held by claude-code@wt-a",
    },
    {
      t: ago(20),
      agent: "codex@wt-c",
      id: "E-0001",
      tag: "immune",
      text: "fix pushed (60 tokens)",
    },
  ],
};
const options = (o: Partial<RenderOptions> = {}): RenderOptions => ({
  width: 80,
  height: 24,
  color: false,
  now: NOW,
  repo: "acme-shop",
  timeZone: "UTC",
  ...o,
});

describe("cells and fit", () => {
  it("count terminal cells", () => {
    expect(cells("abc")).toBe(3);
    expect(cells("错误")).toBe(4);
    expect(cells("😀!")).toBe(3);
    expect(cells("é")).toBe(1);
    expect(cells("a\tb")).toBe(2);
  });

  it("pad, clip with an ellipsis, and drop controls", () => {
    expect(fit("ab", 4)).toBe("ab  ");
    expect(fit("abcdef", 4)).toBe("abc…");
    expect(fit("错误错误", 5)).toBe("错误…");
    expect(fit("错误错误", 6)).toBe("错误… ");
    expect(fit("a\u001b[2Jb", 6)).toBe("a [2Jb");
    expect(fit("anything", 0)).toBe("");
  });
});

describe("renderView", () => {
  it("fills an 80 by 24 terminal exactly, every pane included", () => {
    const lines = renderView(view, options());
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(cells(line)).toBe(80);
    const text = lines.join("\n");
    expect(lines[0]).toMatch(
      /^ antibody  acme-shop .*4 agents · 1 diagnosing · 1,350 tokens saved .*10:00:00 $/,
    );
    expect(text).toContain(
      " Fleet  1 working · 1 diagnosing · 1 holding · 1 immune",
    );
    expect(text).toMatch(/ claude-code@wt-a +◐ diagnosing +E-0003 for 2 min/);
    expect(text).toMatch(
      / gemini@wt-b +◌ holding +E-0003 · claude-code@wt-a is on it/,
    );
    expect(text).toMatch(/ codex@wt-c +✓ immune +E-0001 · saved 740 tokens/);
    expect(text).toMatch(/ claude-code@wt-d +· working +last seen 12 s ago/);
    expect(text).toContain("tokens saved 1,350 (after 250 tokens of notices)");
    expect(text).toContain("antibodies 1 / 3 (2 open) · fleet immunity 100%");
    expect(text).toMatch(
      / E-0001 +pnpm dev → .* Copy \.env.* claude-code@… +2 +1,380 $/m,
    );
    expect(text).toMatch(/ E-0002 +ENOENT: 设定.* wontfix/);
    expect(text).toMatch(/ E-0003 +pnpm test → .* diagnosing \(claude-c…/);
    expect(text).toMatch(
      / 09:59:40 +codex@wt-c +E-0001 +immune +fix pushed \(60 tokens\)/,
    );
    expect(lines.at(-1)).toMatch(
      /^ q quit · space freeze · p pause injection · f filter events · e edit an/,
    );
  });

  it("puts the memory figures on one line when there is room", () => {
    const narrow = renderView(view, options()).join("\n");
    const wide = renderView(view, options({ width: 180 }));
    for (const line of wide) expect(cells(line)).toBe(180);
    expect(narrow).toMatch(/re-diagnoses avoided 2 *\n antibodies 1/);
    expect(wide.join("\n")).toContain(
      "re-diagnoses avoided 2 · antibodies 1 / 3 (2 open) · fleet immunity 100%",
    );
  });

  it("colours without changing the layout", () => {
    const coloured = renderView(view, options({ color: true }));
    expect(coloured.join("")).toMatch(ANSI);
    expect(coloured.map(plain)).toEqual(renderView(view, options()));
  });

  it("keeps the keys on the last line of a short terminal", () => {
    const lines = renderView(view, options({ height: 9 }));
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toContain("q quit");
    expect(lines.join("\n")).not.toContain("fix pushed");
    expect(renderView(view, options({ height: 0 }))).toEqual([]);
  });

  it("shows the newest antibodies when they do not all fit", () => {
    const many: FleetView = {
      ...view,
      agents: [],
      events: [],
      antibodies: Array.from({ length: 40 }, (_, i) => ({
        ...view.antibodies[0]!,
        id: `E-${String(i + 1).padStart(4, "0")}`,
      })),
    };
    const text = renderView(many, options()).join("\n");
    expect(text).toMatch(/ Antibodies  \d+ of 40, newest last/);
    expect(text).toContain("E-0040");
    expect(text).not.toContain("E-0001 ");
  });

  it("says what is empty, and when the view is frozen", () => {
    const empty: FleetView = {
      ...view,
      agents: [],
      antibodies: [],
      events: [],
    };
    const text = renderView(
      empty,
      options({ frozen: true, paused: true }),
    ).join("\n");
    expect(text).toContain("no agent has been seen in the last 30 minutes");
    expect(text).toContain("no errors yet");
    expect(text).toContain("no events yet");
    expect(text.split("\n")[0]).toMatch(/injection paused  frozen  10:00:00 $/);
  });

  it("draws in the machine's time zone by default, and in a narrow terminal", () => {
    const lines = renderView(view, options({ timeZone: undefined, width: 10 }));
    for (const line of lines) expect(cells(line)).toBe(20);
  });

  it("filters the events pane to failures or fixes", () => {
    const failures = renderView(view, options({ filter: "failures" })).join(
      "\n",
    );
    expect(failures).toContain(" Events  failures only");
    expect(failures).toContain("port 3000 in use");
    expect(failures).toContain("held by claude-code@wt-a");
    expect(failures).not.toContain("fix pushed");
    const fixes = renderView(view, options({ filter: "fixes" })).join("\n");
    expect(fixes).toContain("fix pushed (60 tokens)");
    expect(fixes).not.toContain("port 3000 in use");
    const none = renderView(
      { ...view, events: view.events.slice(0, 1) },
      options({ filter: "fixes" }),
    );
    expect(none.join("\n")).toContain("no fixes yet");
  });
});
