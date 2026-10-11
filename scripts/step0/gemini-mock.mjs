// A minimal Gemini API stand-in, so the real Gemini CLI runs probe commands and
// fires its own hooks: it answers the task router's JSON request, then asks the
// client to run each command in STEP0_COMMANDS, then ends the turn. Every
// request is logged, so the tool result the CLI builds is visible.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const commands = JSON.parse(process.env.STEP0_COMMANDS ?? "[]");
const log = process.env.STEP0_REQUESTS;
const port = Number(process.env.STEP0_PORT ?? 15798);

const usage = {
  promptTokenCount: 10,
  candidatesTokenCount: 5,
  totalTokenCount: 15,
};
const answer = (parts) => ({
  candidates: [
    { content: { parts, role: "model" }, finishReason: "STOP", index: 0 },
  ],
  usageMetadata: usage,
});

function reply(body) {
  const text = JSON.stringify(body);
  const schema =
    body.systemInstruction?.parts?.map((p) => p.text).join(" ") ?? "";
  if (schema.includes("Task Routing AI")) {
    return answer([
      {
        text: JSON.stringify({
          complexity_reasoning: "A scripted probe, one command.",
          complexity_score: 5,
        }),
      },
    ]);
  }
  const contents = body.contents ?? [];
  const results = contents.filter((c) =>
    (c.parts ?? []).some((p) => p.functionResponse !== undefined),
  ).length;
  if (results < commands.length) {
    return answer([
      {
        functionCall: {
          name: "run_shell_command",
          args: { command: commands[results] },
        },
      },
    ]);
  }
  void text;
  return answer([{ text: "probe done" }]);
}

createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  if (log !== undefined)
    appendFileSync(log, `${req.method} ${req.url}\n${raw}\n\n`);
  const payload = reply(body);
  if (req.url.includes("streamGenerateContent")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.end();
    return;
  }
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(payload));
}).listen(port, "127.0.0.1", () => console.log("gemini mock up"));
