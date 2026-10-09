import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOOK_EVENTS } from "../src/hook-input";
import { VERSION } from "../src/cli";

// The Claude Code plugin is the repository itself: Claude Code clones it and
// reads these files. `claude plugin validate` checks their shape; these tests
// check that they agree with the code.
const root = fileURLToPath(new URL("..", import.meta.url));
const json = (path: string) =>
  JSON.parse(readFileSync(resolve(root, path), "utf8"));
const BUNDLE = "${CLAUDE_PLUGIN_ROOT}/dist/antibody.mjs";

describe("the Claude Code plugin", () => {
  const plugin = json(".claude-plugin/plugin.json");

  it("carries the package's name and version", () => {
    const pkg = json("package.json");
    expect(plugin.name).toBe(pkg.name);
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.version).toBe(VERSION);
    expect(plugin.license).toBe(pkg.license);
  });

  it("runs the committed bundle for every hook event antibody handles", () => {
    const { hooks } = json("hooks/hooks.json");
    expect(Object.keys(hooks).sort()).toEqual(
      [...HOOK_EVENTS, "PreToolUse"].sort(),
    );
    expect(hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: "node",
            args: [BUNDLE, "hook", "claude-code-pretool"],
            timeout: 5,
          },
        ],
      },
    ]);
    for (const event of HOOK_EVENTS)
      expect(hooks[event]).toEqual([
        {
          hooks: [
            {
              type: "command",
              command: "node",
              args: [BUNDLE, "hook", "claude-code"],
              timeout: 10,
            },
          ],
        },
      ]);
  });

  it("starts the MCP server from the committed bundle, named for Claude Code", () => {
    expect(plugin.mcpServers).toEqual({
      antibody: { command: "node", args: [BUNDLE, "mcp", "claude-code"] },
    });
    // At the repository root, .mcp.json would also be read as this
    // repository's own project config, where CLAUDE_PLUGIN_ROOT is unset.
    expect(existsSync(resolve(root, ".mcp.json"))).toBe(false);
  });

  it("points at a bundle that is committed", () => {
    expect(existsSync(resolve(root, "dist", "antibody.mjs"))).toBe(true);
  });

  it("is listed in the repository's own marketplace", () => {
    const market = json(".claude-plugin/marketplace.json");
    expect(market.plugins).toEqual([
      { name: plugin.name, source: "./", description: plugin.description },
    ]);
  });
});
