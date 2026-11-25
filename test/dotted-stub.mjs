// Minimal MCP stdio server with two tool names that sanitize to the same exposed name
// (`foo.bar` and `foo bar` both become `foo_bar`; hyphens survive sanitizing, dots and
// spaces do not). Used to prove the bridge keeps them distinct.
import process from "node:process";

const tools = [
  {
    name: "foo.bar",
    description: "Dotted tool name",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "foo bar",
    description: "Spaced tool name",
    inputSchema: { type: "object", properties: {} },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function handle(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return;
  if (message.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dotted-stub", version: "0.0.1" },
      },
    });
  }
  if (message.method === "ping") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  if (message.method === "tools/call") {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: String(message.params?.name ?? "") }] },
    });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported: ${message.method}` } });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
