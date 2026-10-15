import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/cli";

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

let root: string;
let oldNode: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "antibody-launch-"));
  // Preloaded with --require, which the launcher does not pass on, so only the
  // launcher sees an old Node and ANTIBODY_NODE runs the bundle for real.
  oldNode = join(root, "old-node.cjs");
  writeFileSync(
    oldNode,
    'Object.defineProperty(process.versions, "node", { value: "18.20.8" });\n',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const launch = (
  args: string[],
  { old = false, antibodyNode = undefined as string | undefined, input = "" },
) => {
  const env = { ...process.env };
  delete env.ANTIBODY_NODE;
  if (antibodyNode) env.ANTIBODY_NODE = antibodyNode;
  const preload = old ? ["--require", oldNode] : [];
  const result = spawnSync(process.execPath, [...preload, launcher, ...args], {
    input,
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const initialize = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;

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
});

describe("the launcher on a new enough Node", () => {
  it("runs the committed bundle in-process with the same arguments", () => {
    expect(launch(["--version"], {})).toEqual({
      status: 0,
      stdout: `${VERSION}\n`,
      stderr: "",
    });
  });

  it("serves MCP over the same stdio", () => {
    const { stdout } = launch(["mcp", "claude-code"], { input: initialize });
    expect(JSON.parse(stdout.trim()).id).toBe(1);
  });
});

describe("the launcher on an older Node", () => {
  it("runs the bundle under ANTIBODY_NODE with the same arguments", () => {
    expect(
      launch(["--version"], { old: true, antibodyNode: process.execPath }),
    ).toEqual({ status: 0, stdout: `${VERSION}\n`, stderr: "" });
  });

  it("passes stdin and stdout through to the MCP server", () => {
    const { stdout } = launch(["mcp", "claude-code"], {
      old: true,
      antibodyNode: process.execPath,
      input: initialize,
    });
    expect(JSON.parse(stdout.trim()).id).toBe(1);
  });

  it("exits with the bundle's exit code", () => {
    const direct = launch(["no-such-command"], {});
    expect(direct.status).not.toBe(0);
    expect(
      launch(["no-such-command"], {
        old: true,
        antibodyNode: process.execPath,
      }).status,
    ).toBe(direct.status);
  });

  it("explains and exits 0 when ANTIBODY_NODE cannot run", () => {
    const result = launch(["--version"], {
      old: true,
      antibodyNode: join(root, "missing-node"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cannot run ANTIBODY_NODE");
  });

  it("explains and exits 0 without ANTIBODY_NODE", () => {
    const result = launch(["--version"], { old: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Node 18.20.8 is older than 22.13");
    expect(result.stderr).toContain("ANTIBODY_NODE");
  });
});
