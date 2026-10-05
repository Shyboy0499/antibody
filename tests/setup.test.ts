import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli";
import {
  CODEX_HOOK_TIMEOUT_SEC,
  GEMINI_HOOK_TIMEOUT_MS,
  codexHooks,
  geminiSettings,
  runSetup,
  shellQuote,
} from "../src/setup";

const BUNDLE = "/opt/antibody/dist/antibody.mjs";
const ours = {
  hooks: [
    {
      type: "command",
      name: "antibody",
      command: `node ${BUNDLE} hook gemini`,
      timeout: GEMINI_HOOK_TIMEOUT_MS,
    },
  ],
};
const server = { command: "node", args: [BUNDLE, "mcp", "gemini"] };

describe("geminiSettings", () => {
  it("adds a hook for each event and the MCP server", () => {
    expect(geminiSettings({}, BUNDLE, "node")).toEqual({
      hooks: {
        SessionStart: [ours],
        BeforeAgent: [ours],
        AfterTool: [ours],
        SessionEnd: [ours],
      },
      mcpServers: { antibody: server },
    });
  });

  it("replaces its own entries and keeps everything else", () => {
    const theirs = {
      matcher: "write_file",
      hooks: [{ type: "command", command: "./lint.sh" }],
    };
    const mixed = {
      hooks: [
        { type: "command", name: "antibody", command: "old" },
        { type: "command", name: "audit", command: "./audit.sh" },
      ],
    };
    const before = {
      theme: "dark",
      hooks: { AfterTool: [theirs, mixed], Notification: [theirs] },
      mcpServers: { github: { command: "gh-mcp" } },
    };
    const once = geminiSettings(before, BUNDLE, "node");
    expect(once).toEqual({
      theme: "dark",
      hooks: {
        AfterTool: [theirs, mixed, ours],
        Notification: [theirs],
        SessionStart: [ours],
        BeforeAgent: [ours],
        SessionEnd: [ours],
      },
      mcpServers: { github: { command: "gh-mcp" }, antibody: server },
    });
    expect(geminiSettings(once, BUNDLE, "node")).toEqual(once);
    expect(before.hooks.AfterTool).toHaveLength(2);
  });

  it("takes its entries out again, leaving no empty sections", () => {
    const added = geminiSettings({ theme: "dark" }, BUNDLE, "node");
    expect(geminiSettings(added, BUNDLE, "node", true)).toEqual({
      theme: "dark",
    });
    const kept = geminiSettings(
      {
        hooks: { AfterTool: [{ hooks: [{ type: "command", command: "x" }] }] },
        mcpServers: { github: { command: "gh-mcp" } },
      },
      BUNDLE,
      "node",
    );
    expect(geminiSettings(kept, BUNDLE, "node", true)).toEqual({
      hooks: { AfterTool: [{ hooks: [{ type: "command", command: "x" }] }] },
      mcpServers: { github: { command: "gh-mcp" } },
    });
  });

  it("ignores hook sections that are not lists", () => {
    expect(
      geminiSettings(
        { hooks: { AfterTool: "oops" }, mcpServers: [] },
        BUNDLE,
        "node",
      ).hooks,
    ).toMatchObject({ AfterTool: [ours] });
  });

  it("quotes paths a shell would split", () => {
    expect(shellQuote("/opt/antibody/dist/antibody.mjs")).toBe(
      "/opt/antibody/dist/antibody.mjs",
    );
    expect(shellQuote("/opt/My Tools/antibody.mjs")).toBe(
      "'/opt/My Tools/antibody.mjs'",
    );
    expect(shellQuote("/tmp/it's")).toBe(`'/tmp/it'"'"'s'`);
    const { hooks } = geminiSettings({}, "/a b/antibody.mjs", "node");
    expect(
      (hooks as { AfterTool: (typeof ours)[] }).AfterTool[0]!.hooks[0]!.command,
    ).toBe("node '/a b/antibody.mjs' hook gemini");
  });
});

describe("antibody setup gemini", () => {
  let home: string;
  let out: string;
  let err: string;
  const file = () => join(home, ".gemini", "settings.json");
  const setup = (...args: string[]) =>
    runSetup(
      args,
      {
        stdout: (t) => void (out += t),
        stderr: (t) => void (err += t),
        env: { HOME: home },
      },
      { bundle: BUNDLE },
    );
  const read = () => JSON.parse(readFileSync(file(), "utf8"));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "antibody-setup-"));
    out = "";
    err = "";
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes Gemini CLI's user settings, and does it once", async () => {
    expect(await setup("gemini")).toBe(0);
    expect(out).toBe(
      `Added antibody's hooks (SessionStart, BeforeAgent, AfterTool, SessionEnd) and MCP server to ${file()}.\nRestart Gemini CLI to load them.\n`,
    );
    expect(read()).toEqual(geminiSettings({}, BUNDLE, "node"));
    expect(readFileSync(file(), "utf8").endsWith("}\n")).toBe(true);
    expect(await setup("gemini")).toBe(0);
    expect(read()).toEqual(geminiSettings({}, BUNDLE, "node"));
  });

  it("keeps the user's settings and removes only its own", async () => {
    mkdirSync(join(home, ".gemini"));
    writeFileSync(file(), JSON.stringify({ theme: "dark" }));
    await setup("gemini");
    expect(read().theme).toBe("dark");
    out = "";
    expect(await setup("gemini", "--remove")).toBe(0);
    expect(out).toBe(
      `Removed antibody's hooks and MCP server from ${file()}.\n`,
    );
    expect(read()).toEqual({ theme: "dark" });
  });

  it("prints instead of writing when asked, to any settings file", async () => {
    const other = join(home, "custom.json");
    expect(await setup("gemini", "--settings", other, "--print")).toBe(0);
    expect(JSON.parse(out)).toEqual(geminiSettings({}, BUNDLE, "node"));
    expect(() => readFileSync(other)).toThrow();
  });

  it("leaves a settings file with comments alone", async () => {
    mkdirSync(join(home, ".gemini"));
    const commented = '{\n  // my theme\n  "theme": "dark"\n}\n';
    writeFileSync(file(), commented);
    expect(await setup("gemini")).toBe(1);
    expect(err).toContain("is not plain JSON (comments, perhaps)");
    expect(readFileSync(file(), "utf8")).toBe(commented);
    err = "";
    expect(await setup("gemini", "--print")).toBe(0);
    expect(err).toContain("printing antibody's entries alone");
    expect(JSON.parse(out)).toEqual(geminiSettings({}, BUNDLE, "node"));
  });

  it("treats an empty file as no settings, and reports one it cannot read", async () => {
    mkdirSync(join(home, ".gemini"));
    writeFileSync(file(), "  \n");
    expect(await setup("gemini")).toBe(0);
    expect(await setup("gemini", "--settings", home)).toBe(1);
    expect(err).toContain(`cannot read ${home}`);
  });

  it("refuses arguments it does not understand", async () => {
    for (const args of [
      [],
      ["cursor"],
      ["gemini", "--force"],
      ["gemini", "extra"],
      ["gemini", "--settings"],
    ]) {
      err = "";
      expect(await setup(...args), args.join(" ")).toBe(2);
      expect(err).toContain("usage: antibody setup <gemini|codex>");
    }
  });

  it("is reached from the command line", async () => {
    const code = await main(
      ["setup", "gemini", "--print"],
      {
        readStdin: async () => "",
        stdout: (t) => void (out += t),
        stderr: (t) => void (err += t),
        env: { HOME: home },
      },
      { bundle: BUNDLE },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).mcpServers.antibody).toEqual(server);
  });
});

describe("codexHooks", () => {
  const codexHook = {
    hooks: [
      {
        type: "command",
        command: `node ${BUNDLE} hook codex`,
        timeout: CODEX_HOOK_TIMEOUT_SEC,
      },
    ],
  };

  it("adds a hook for each event Codex reports", () => {
    expect(codexHooks({}, BUNDLE, "node")).toEqual({
      hooks: {
        SessionStart: [codexHook],
        UserPromptSubmit: [codexHook],
        PostToolUse: [codexHook],
        SessionEnd: [codexHook],
      },
    });
  });

  it("replaces its own hooks, from any bundle path, and keeps the rest", () => {
    const theirs = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "./audit.sh", timeout: 5 }],
    };
    const stale = {
      hooks: [
        { type: "command", command: "node /old/antibody.mjs hook codex" },
      ],
    };
    const before = {
      description: "team hooks",
      hooks: { PostToolUse: [theirs, stale], Stop: [theirs] },
    };
    const after = codexHooks(before, BUNDLE, "node");
    expect(after).toEqual({
      description: "team hooks",
      hooks: {
        PostToolUse: [theirs, codexHook],
        Stop: [theirs],
        SessionStart: [codexHook],
        UserPromptSubmit: [codexHook],
        SessionEnd: [codexHook],
      },
    });
    expect(codexHooks(after, BUNDLE, "node")).toEqual(after);
    expect(codexHooks(after, BUNDLE, "node", true)).toEqual({
      description: "team hooks",
      hooks: { PostToolUse: [theirs], Stop: [theirs] },
    });
    expect(
      codexHooks(codexHooks({}, BUNDLE, "node"), BUNDLE, "node", true),
    ).toEqual({});
  });
});

describe("antibody setup codex", () => {
  let home: string;
  let out: string;
  const setup = (env: NodeJS.ProcessEnv, ...args: string[]) =>
    runSetup(
      args,
      {
        stdout: (t) => void (out += t),
        stderr: () => undefined,
        env: { HOME: home, ...env },
      },
      { bundle: BUNDLE },
    );

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "antibody-setup-codex-"));
    out = "";
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes ~/.codex/hooks.json and says how to trust it and add the MCP server", async () => {
    expect(await setup({}, "codex")).toBe(0);
    const file = join(home, ".codex", "hooks.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
      codexHooks({}, BUNDLE, "node"),
    );
    expect(out).toBe(
      [
        `Added antibody's hooks (SessionStart, UserPromptSubmit, PostToolUse, SessionEnd) to ${file}.`,
        "Codex runs new hooks once you trust them: review them with /hooks.",
        "To add the MCP server too, run",
        `  codex mcp add antibody -- node ${BUNDLE} mcp codex`,
        "",
      ].join("\n"),
    );
    out = "";
    expect(await setup({}, "codex", "--remove")).toBe(0);
    expect(out).toBe(
      `Removed antibody's hooks from ${file}.\nIf you added its MCP server, remove it with: codex mcp remove antibody\n`,
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  it("follows CODEX_HOME", async () => {
    const codexHome = join(home, "elsewhere");
    expect(await setup({ CODEX_HOME: codexHome }, "codex")).toBe(0);
    expect(
      JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8")).hooks,
    ).toHaveProperty("PostToolUse");
  });
});
