// The MCP server: the agent tools over the Model Context Protocol's stdio
// transport, for Claude Code and for agents with no hooks at all (Cursor,
// OpenCode, Aider and others, design §5).
//
// It is written by hand rather than with the MCP SDK, which would add a
// dependency tree to the committed bundle for four methods. The transport is
// JSON-RPC 2.0, one message per line on stdin and stdout. The server answers
// initialize, ping, tools/list and tools/call; it ignores notifications and
// responses, and refuses batches, which the protocol dropped in 2025-06-18.
//
// Requests are handled as they arrive, so a slow tool call does not hold up a
// ping; responses may leave in a different order, matched by their ids.
import { createInterface } from "node:readline";
import type { Tool } from "./tools";

/** Protocol versions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** JSON-RPC error codes. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** What the server tells a client it is. */
export interface ServerInfo {
  name: string;
  version: string;
}

/**
 * What the server tells the agent, once, at initialization: when to reach for
 * the tools. Clients may add it to the system prompt.
 */
export const MCP_INSTRUCTIONS =
  "antibody shares error fixes across the coding agents working on this repository. When a command or tool fails with an error you have not seen, call antibody_lookup with the error text before diagnosing it: another agent may already have fixed it, or be fixing it now. When you get past an error, call antibody_record with its entry ID and the fix in a sentence or two, so every other agent gets it.";

type Id = string | number | null;

/** A JSON-RPC response. */
export type RpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

/** One MCP session's message handler. */
export interface McpServer {
  /**
   * Handle one parsed message. Never throws.
   *
   * @returns the response, or undefined for a notification or a response.
   */
  handle(message: unknown): Promise<RpcResponse | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is Id =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  value === null;

const failure = (id: Id, code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * Serve tools to one MCP client.
 *
 * @param tools - from createTools().
 * @param info - the name and version the server reports.
 */
export function createMcpServer(tools: Tool[], info: ServerInfo): McpServer {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = (
          MCP_PROTOCOL_VERSIONS as readonly unknown[]
        ).includes(asked)
          ? asked
          : MCP_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: info,
          instructions: MCP_INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: t.readOnly, openWorldHint: false },
          })),
        };
      case "tools/call": {
        const tool =
          typeof params.name === "string" ? byName.get(params.name) : undefined;
        if (tool === undefined)
          throw new RpcError(
            RPC_ERROR.invalidParams,
            `unknown tool: ${String(params.name)}`,
          );
        const result = await tool.call(params.arguments);
        return {
          content: [{ type: "text", text: result.text }],
          isError: result.isError,
        };
      }
      default:
        throw new RpcError(
          RPC_ERROR.methodNotFound,
          `method not found: ${method}`,
        );
    }
  }

  return {
    async handle(message) {
      if (Array.isArray(message))
        return failure(
          null,
          RPC_ERROR.invalidRequest,
          "batches are not supported",
        );
      if (!isRecord(message) || message.jsonrpc !== "2.0")
        return failure(
          null,
          RPC_ERROR.invalidRequest,
          "not a JSON-RPC 2.0 message",
        );
      // A response to a request this server never sends.
      if (message.method === undefined && "id" in message) return undefined;
      const { id, method, params } = message;
      const notification = !("id" in message);
      if (typeof method !== "string" || (!notification && !isId(id)))
        return notification
          ? undefined
          : failure(
              isId(id) ? id : null,
              RPC_ERROR.invalidRequest,
              "invalid request",
            );
      if (notification) return undefined;
      if (params !== undefined && !isRecord(params))
        return failure(
          id as Id,
          RPC_ERROR.invalidParams,
          "params must be an object",
        );
      try {
        return {
          jsonrpc: "2.0",
          id: id as Id,
          result: await call(method, params ?? {}),
        };
      } catch (error) {
        return error instanceof RpcError
          ? failure(id as Id, error.code, error.message)
          : failure(id as Id, RPC_ERROR.internal, "internal error");
      }
    },
  };
}

/** A JSON-RPC error to send back for a request. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Run a server over a line stream until the input ends: one JSON message per
 * line in, one per line out.
 *
 * @param server - the handler.
 * @param input - stdin, or a stream in tests.
 * @param write - where each response line goes.
 * @returns once the input has ended and every response is written.
 */
export async function serveLines(
  server: McpServer,
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
): Promise<void> {
  const pending: Promise<void>[] = [];
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(
        `${JSON.stringify(failure(null, RPC_ERROR.parse, "parse error"))}\n`,
      );
      continue;
    }
    pending.push(
      server.handle(message).then((response) => {
        if (response !== undefined) write(`${JSON.stringify(response)}\n`);
      }),
    );
  }
  await Promise.all(pending);
}
