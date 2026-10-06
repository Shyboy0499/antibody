// The shop's HTTP API.
import { createServer } from "node:http";
import { cartTotal } from "./cart.js";
import { config } from "./config.js";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/cart/total") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        send(res, 200, { totalCents: cartTotal(JSON.parse(body).lines ?? []) });
      } catch (error) {
        send(res, 400, { error: error.message });
      }
    });
    return;
  }
  send(res, 404, { error: "not found" });
}

/** Start the API on the configured port; resolves once it listens. */
export function start(port = config.port) {
  const server = createServer(handle);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}
