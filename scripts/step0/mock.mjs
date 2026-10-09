// Minimal Anthropic-compatible endpoint: replays a fixed list of Bash tool calls so
// Claude Code really runs them and fires its hooks with real stdin.
import { createServer } from "node:http";
const commands = JSON.parse(process.env.STEP0_COMMANDS);
const sse = (res, event, data) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!req.url.startsWith("/v1/messages")) {
    res.writeHead(404).end("{}");
    return;
  }
  const parsed = JSON.parse(body || "{}");
  const toolResults =
    JSON.stringify(parsed.messages ?? []).split('"tool_result"').length - 1;
  const msg = {
    id: `msg_${toolResults}`,
    type: "message",
    role: "assistant",
    model: parsed.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  sse(res, "message_start", { type: "message_start", message: msg });
  if (toolResults < commands.length) {
    const input = JSON.stringify({
      command: commands[toolResults],
      description: "step0 probe",
    });
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: `toolu_${toolResults}`,
        name: "Bash",
        input: {},
      },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: input },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
  } else {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "done" },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
  }
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}).listen(15799, "127.0.0.1", () => console.log("mock up"));
