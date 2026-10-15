import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/cli";

// hooks/launch.cjs is what the Claude Code plugin starts. CI runs a Node new
// enough for the bundle, so the hand-over to an older Node's ANTIBODY_NODE is
// tested through plan(); the in-process path runs for real.
const launcher = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "hooks",
  "launch.cjs",
);
const { supported, plan } = createRequire(import.meta.url)(launcher) as {
  supported: (version: string) => boolean;
  plan: (
    version: string,
    env: Record<string, string | undefined>,
  ) => { kind: string; node?: string; message?: string };
};
const run = (args: string[], input = "") =>
  execFileSync(process.execPath, [launcher, ...args], { input }).toString();

describe("the launcher's version check", () => {
  it("accepts 22.13 and anything newer", () => {
    for (const version of ["22.13.0", "22.20.1", "23.0.0", "24.9.0"])
      expect(supported(version)).toBe(true);
  });

  it("rejects anything older than 22.13", () => {
    for (const version of ["22.12.0", "21.7.3", "20.19.0", "18.20.8"])
      expect(supported(version)).toBe(false);
  });
});

describe("the launcher's plan", () => {
  it("loads the bundle in-process on a new enough Node", () => {
    expect(plan("22.13.0", { ANTIBODY_NODE: "<path>/node" })).toEqual({
      kind: "import",
    });
  });

  it("hands over to ANTIBODY_NODE on an older Node", () => {
    expect(plan("18.20.8", { ANTIBODY_NODE: "<path>/node" })).toEqual({
      kind: "spawn",
      node: "<path>/node",
    });
  });

  it("says why it does nothing on an older Node without ANTIBODY_NODE", () => {
    const next = plan("18.20.8", {});
    expect(next.kind).toBe("skip");
    expect(next.message).toContain("Node 18.20.8 is older than 22.13");
    expect(next.message).toContain("ANTIBODY_NODE");
  });
});

describe("the launcher on this Node", () => {
  it("runs the committed bundle with the same arguments", () => {
    expect(run(["--version"])).toBe(`${VERSION}\n`);
  });

  it("passes stdio through to the MCP server", () => {
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;
    const response = JSON.parse(run(["mcp", "claude-code"], line).trim());
    expect(response.id).toBe(1);
  });
});
