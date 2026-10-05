// The screen of `antibody watch`: a FleetView laid out as terminal lines.
//
// Pure: it returns exactly `height` lines, each exactly `width` cells wide,
// so the watcher can redraw by overwriting the screen in place, without
// clearing it first, and without flicker. Colours are ANSI SGR codes, added
// after the padding is measured, and left out when `color` is false.
//
// The panes stack top to bottom, as in demo/index.html: a status line, the
// fleet, the memory figures, the antibodies, the events filling what is left,
// and a line of keys. An 80-column terminal gets every pane; wider ones get
// wider columns.
import { elapsedText } from "./notice";
import type {
  AgentRow,
  AntibodyRow,
  EventLine,
  FleetView,
} from "./watch-model";

/** Which events the events pane shows; f cycles through them. */
export const EVENT_FILTERS = ["all", "failures", "fixes"] as const;
export type EventFilter = (typeof EVENT_FILTERS)[number];

// The tags each filter keeps.
const FILTER_TAGS: Record<Exclude<EventFilter, "all">, EventLine["tag"][]> = {
  failures: ["new", "again", "holding"],
  fixes: ["antibody", "immune", "resolved"],
};

/** How the screen is drawn. */
export interface RenderOptions {
  width: number;
  height: number;
  color: boolean;
  now: Date;
  /** The repository the memory belongs to, as the status line names it. */
  repo: string;
  /** The view is frozen: the status line says so. */
  frozen?: boolean;
  /** Injection is paused: the status line says so. */
  paused?: boolean;
  /** Which events to show; all by default. */
  filter?: EventFilter;
  /** The time zone clocks are shown in; the machine's by default. */
  timeZone?: string;
}

const SGR = {
  bold: "1",
  dim: "2",
  red: "31",
  green: "32",
  yellow: "33",
  cyan: "36",
  inverse: "7",
} as const;
type Style = keyof typeof SGR;

// Code points a terminal draws two cells wide: CJK, Hangul, full-width forms
// and most emoji.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;
// Code points that take no cell: controls and combining marks.
const ZERO = /[\u0000-\u001f\u007f-\u009f̀-ͯ​-‏]/u;

/** How many terminal cells a string takes. */
export function cells(text: string): number {
  let n = 0;
  for (const ch of text) n += ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
  return n;
}

/**
 * A string made exactly `width` cells wide: clipped with an ellipsis, or
 * padded with spaces. Controls are dropped, so text from the memory cannot
 * move the cursor.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  if (cells(clean) <= width) return clean + " ".repeat(width - cells(clean));
  let out = "";
  let used = 0;
  for (const ch of clean) {
    const w = ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…${" ".repeat(width - 1 - used)}`;
}

const thousands = (n: number) => Math.round(n).toLocaleString("en-US");

/** One screen of the fleet view. */
export function renderView(view: FleetView, o: RenderOptions): string[] {
  const width = Math.max(20, o.width);
  const paint = (text: string, ...styles: Style[]) =>
    o.color && styles.length > 0
      ? `\u001b[${styles.map((s) => SGR[s]).join(";")}m${text}\u001b[0m`
      : text;
  // A line from cells: each a text, its width, and its styles.
  type Cell = [text: string, width: number, ...styles: Style[]];
  const row = (...parts: Cell[]) => {
    // Fixed widths are granted left to right while they fit; a width of -1
    // takes whatever they leave. The line always comes out `width` wide.
    let budget = width;
    const sizes = parts.map(([, w]) => {
      if (w < 0) return -1;
      const size = Math.min(Math.max(0, w), budget);
      budget -= size;
      return size;
    });
    let line = "";
    parts.forEach(([text, , ...styles], i) => {
      let size = sizes[i] as number;
      if (size < 0) {
        size = budget;
        budget = 0;
      }
      line += paint(fit(text, size), ...styles);
    });
    return line + " ".repeat(budget);
  };
  // One formatter for the frame: building one per row is the slow part.
  const clockFormat = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(o.timeZone === undefined ? {} : { timeZone: o.timeZone }),
  });
  const clock = (iso: string | Date) => clockFormat.format(new Date(iso));
  const ago = (iso: string) => elapsedText(o.now.getTime() - Date.parse(iso));
  const heading = (title: string, summary = "") =>
    row([` ${title}  `, cells(title) + 3, "bold"], [summary, -1, "dim"]);

  // Status line.
  const diagnosing = view.agents.filter((a) => a.state === "diagnosing").length;
  const right = `${o.paused === true ? "injection paused  " : ""}${o.frozen === true ? "frozen  " : ""}${clock(o.now)} `;
  const status = row(
    [" antibody ", 10, "bold", "inverse"],
    [` ${o.repo}`, -1],
    [
      `  ${view.agents.length} agents · ${diagnosing} diagnosing · ${thousands(view.memory.tokensSaved)} tokens saved  `,
      Math.min(64, width - 10 - cells(right) - 10),
      "dim",
    ],
    [right, cells(right)],
  );

  // Fleet.
  const counts = { working: 0, diagnosing: 0, holding: 0, immune: 0 };
  for (const a of view.agents) counts[a.state]++;
  const nameWidth = Math.min(28, Math.max(12, Math.floor(width * 0.28)));
  const agentRow = (a: AgentRow) => {
    const states = {
      diagnosing: ["◐ diagnosing", "yellow"],
      holding: ["◌ holding", "yellow"],
      immune: ["✓ immune", "green"],
      working: ["· working", "dim"],
    } as const;
    const [label, style] = states[a.state];
    const detail =
      a.state === "diagnosing"
        ? `${a.id} for ${ago(a.since as string)}`
        : a.state === "holding"
          ? `${a.id} · ${a.holder} is on it`
          : a.state === "immune"
            ? `${a.id ?? ""} · saved ${thousands(a.saved ?? 0)} tokens`
            : `last seen ${ago(a.lastSeen)} ago`;
    return row(
      [` ${a.agent}`, nameWidth],
      [label, 14, style],
      [detail, -1, a.state === "working" ? "dim" : "cyan"],
    );
  };

  // Memory.
  const m = view.memory;
  const memoryParts = [
    `tokens saved ${thousands(m.tokensSaved)} (after ${thousands(m.noticeTokens)} tokens of notices)`,
    `re-diagnoses avoided ${m.avoided}`,
    `antibodies ${m.antibodies} / ${m.entries} (${m.open} open)`,
    `fleet immunity ${Math.round(m.immunity * 100)}%`,
  ];
  const memoryLines =
    cells(memoryParts.join(" · ")) + 2 <= width
      ? [memoryParts.join(" · ")]
      : [memoryParts.slice(0, 2).join(" · "), memoryParts.slice(2).join(" · ")];

  // Antibodies.
  const byWidth = Math.min(22, Math.floor(width * 0.18));
  const flexible = width - 9 - byWidth - 8 - 9;
  const titleWidth = Math.floor(flexible * 0.45);
  const antibodyRow = (a: AntibodyRow) => {
    const [fix, style]: [string, Style] =
      a.fix !== ""
        ? [a.fix, "green"]
        : a.diagnosing !== undefined
          ? [`diagnosing (${a.diagnosing})`, "yellow"]
          : [a.status === "wontfix" ? "wontfix" : "open", "red"];
    return row(
      [` ${a.id}`, 9, "cyan"],
      // The tag (`[command-exit:Bash]`) costs columns the error needs more.
      [a.title.replace(/^\[[^\]]*\]\s*/, ""), titleWidth],
      [` ${fix}`, flexible - titleWidth, style],
      [` ${a.beatenBy ?? "-"}`, byWidth, "dim"],
      [`${a.reused}`.padStart(7), 8],
      [`${thousands(a.saved)}`.padStart(8), 9],
    );
  };

  // Events.
  const tagStyle: Record<EventLine["tag"], Style> = {
    new: "red",
    again: "red",
    claimed: "dim",
    holding: "yellow",
    antibody: "green",
    immune: "green",
    notice: "dim",
    released: "dim",
    resolved: "green",
    forgotten: "dim",
  };
  const eventRow = (e: EventLine) =>
    row(
      [` ${clock(e.t)}`, 10, "dim"],
      [` ${e.agent}`, nameWidth],
      [` ${e.id ?? ""}`, 9, "cyan"],
      [` ${e.tag}`, 10, tagStyle[e.tag]],
      [` ${e.text}`, -1],
    );

  const keys = row([
    " q quit · space freeze · p pause injection · f filter events · e edit antibodies",
    -1,
    "dim",
  ]);
  const filter = o.filter ?? "all";
  const events =
    filter === "all"
      ? view.events
      : view.events.filter((e) => FILTER_TAGS[filter].includes(e.tag));

  // Rows: the fixed lines first, then the panes share what is left, the
  // events taking whatever the fleet and the antibodies do not need.
  const fixed = 1 + 1 + 1 + memoryLines.length + 1 + 1 + 1 + 1; // + headers
  const room = Math.max(0, o.height - fixed);
  const fleetRows = Math.min(
    Math.max(1, view.agents.length),
    Math.max(1, Math.floor(room * 0.35)),
  );
  const antibodyRows = Math.min(
    Math.max(1, view.antibodies.length),
    Math.max(1, Math.floor(room * 0.3)),
  );
  const eventRows = Math.max(0, room - fleetRows - antibodyRows);

  const empty = (text: string) => row([` ${text}`, -1, "dim"]);
  const lines = [
    status,
    heading(
      "Fleet",
      `${counts.working} working · ${counts.diagnosing} diagnosing · ${counts.holding} holding · ${counts.immune} immune`,
    ),
    ...(view.agents.length === 0
      ? [empty("no agent has been seen in the last 30 minutes")]
      : view.agents.slice(0, fleetRows).map(agentRow)),
    heading("Memory"),
    ...memoryLines.map((text) => row([` ${text}`, -1])),
    heading(
      "Antibodies",
      view.antibodies.length > antibodyRows
        ? `${antibodyRows} of ${view.antibodies.length}, newest last`
        : "",
    ),
    ...(view.antibodies.length === 0
      ? [empty("no errors yet")]
      : view.antibodies.slice(-antibodyRows).map(antibodyRow)),
    heading("Events", filter === "all" ? "" : `${filter} only`),
    ...(events.length === 0
      ? [empty(filter === "all" ? "no events yet" : `no ${filter} yet`)]
      : // slice(-0) would be every event.
        events.slice(events.length - eventRows).map(eventRow)),
  ];
  const blank = " ".repeat(width);
  const body = lines.slice(0, Math.max(0, o.height - 1));
  while (body.length < o.height - 1) body.push(blank);
  return o.height > 0 ? [...body, keys] : [];
}
