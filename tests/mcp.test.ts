import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  MCP_INSTRUCTIONS,
  MCP_PROTOCOL_VERSIONS,
  RPC_ERROR,
  createMcpServer,
  serveLines,
} from "../src/mcp";
import type { Tool } from "../src/tools";

const echo: Tool = {
  name: "antibody_echo",
  description: "Echo the text argument back.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  readOnly: true,
  async call(args) {
    const text = (args as { text?: unknown } | undefined)?.text;
    return typeof text === "string"
      ? { text, isError: false }
      : { text: "antibody_echo: text is required", isError: true };
  },
};
const broken: Tool = {
  ...echo,
  name: "antibody_broken",
  readOnly: false,
  call: () => Promise.reject(new Error("boom")),
};
const server = () =>
  createMcpServer([echo, broken], { name: "antibody", version: "1.2.3" });
const request = (method: string, params?: unknown, id: unknown = 1) =>
  server().handle({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });

describe("createMcpServer: lifecycle", () => {
  it("initializes with the version the client asks for, when it speaks it", async () => {
    expect(
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-code", version: "2.1.289" },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "antibody", version: "1.2.3" },
        instructions: MCP_INSTRUCTIONS,
      },
    });
  });

  it("offers its newest version otherwise", async () => {
    for (const asked of ["2099-01-01", undefined])
      expect(
        await request("initialize", { protocolVersion: asked }),
      ).toMatchObject({
        result: { protocolVersion: MCP_PROTOCOL_VERSIONS[0] },
      });
  });

  it("answers a ping and ignores notifications", async () => {
    expect(await request("ping", undefined, "p-1")).toEqual({
      jsonrpc: "2.0",
      id: "p-1",
      result: {},
    });
    expect(
      await server().handle({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toBeUndefined();
    expect(
      await server().handle({ jsonrpc: "2.0", method: "tools/call" }),
    ).toBeUndefined();
    expect(
      await server().handle({ jsonrpc: "2.0", method: 7 }),
    ).toBeUndefined();
  });

  it("ignores responses, since it sends no requests", async () => {
    expect(
      await server().handle({ jsonrpc: "2.0", id: 4, result: {} }),
    ).toBeUndefined();
  });
});

describe("createMcpServer: tools", () => {
  it("lists the tools with their schemas and hints", async () => {
    expect(await request("tools/list", {})).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "antibody_echo",
            description: echo.description,
            inputSchema: echo.inputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          {
            name: "antibody_broken",
            description: echo.description,
            inputSchema: echo.inputSchema,
            annotations: { readOnlyHint: false, openWorldHint: false },
          },
        ],
      },
    });
  });

  it("calls a tool and returns its text", async () => {
    expect(
      await request("tools/call", {
        name: "antibody_echo",
        arguments: { text: "hello" },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "hello" }], isError: false },
    });
  });

  it("passes a tool's own error on as a result", async () => {
    expect(
      await request("tools/call", { name: "antibody_echo" }),
    ).toMatchObject({
      result: {
        content: [{ type: "text", text: "antibody_echo: text is required" }],
        isError: true,
      },
    });
  });

  it("refuses an unknown tool", async () => {
    expect(await request("tools/call", { name: "rm_rf" })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: RPC_ERROR.invalidParams, message: "unknown tool: rm_rf" },
    });
    expect(await request("tools/call")).toMatchObject({
      error: { message: "unknown tool: undefined" },
    });
  });

  it("reports a tool that throws as an internal error", async () => {
    expect(
      await request("tools/call", {
        name: "antibody_broken",
        arguments: { text: "x" },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: RPC_ERROR.internal, message: "internal error" },
    });
  });
});

describe("createMcpServer: malformed requests", () => {
  it.each([
    [
      "a batch",
      [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      "batches are not supported",
    ],
    ["a string", "ping", "not a JSON-RPC 2.0 message"],
    ["JSON-RPC 1.0", { id: 1, method: "ping" }, "not a JSON-RPC 2.0 message"],
  ])("refuses %s", async (_name, message, text) => {
    expect(await server().handle(message)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: RPC_ERROR.invalidRequest, message: text },
    });
  });

  it("refuses a request without a usable method or id", async () => {
    expect(await request("", undefined, { nested: true })).toMatchObject({
      id: null,
      error: { code: RPC_ERROR.invalidRequest },
    });
    expect(
      await server().handle({ jsonrpc: "2.0", id: 3, method: ["ping"] }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: RPC_ERROR.invalidRequest, message: "invalid request" },
    });
  });

  it("refuses params that are not an object", async () => {
    expect(await request("ping", [1, 2])).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: RPC_ERROR.invalidParams,
        message: "params must be an object",
      },
    });
  });

  it("refuses an unknown method", async () => {
    expect(await request("resources/list", {})).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: RPC_ERROR.methodNotFound,
        message: "method not found: resources/list",
      },
    });
  });
});

describe("serveLines", () => {
  const serve = async (lines: string[]) => {
    const input = new PassThrough();
    const out: string[] = [];
    const done = serveLines(server(), input, (line) => out.push(line));
    for (const line of lines) input.write(line);
    input.end();
    await done;
    return out;
  };

  it("answers one line per request and none per notification", async () => {
    const out = await serve([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\r\n`,
      "\n",
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "antibody_echo", arguments: { text: "a\nb" } } })}`,
    ]);
    expect(out.every((line) => line.endsWith("\n"))).toBe(true);
    expect(out.every((line) => line.indexOf("\n") === line.length - 1)).toBe(
      true,
    );
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "a\nb" }], isError: false },
      },
    ]);
  });

  it("answers a line that is not JSON with a parse error", async () => {
    expect((await serve(["{oops\n"])).map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_ERROR.parse, message: "parse error" },
      },
    ]);
  });
});
