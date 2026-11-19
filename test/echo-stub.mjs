// Minimal MCP stdio server used by test/reconnect.test.ts: one echo tool, and nothing
// that keeps the process alive once stdin closes.
import process from "node:process";

const tools = [
  {
    name: "say",
    description: "Echo the text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
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
        serverInfo: { name: "echo-stub", version: "0.0.1" },
      },
    });
  }
  if (message.method === "ping") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  if (message.method === "tools/call") {
    if (message.params?.name !== "say") {
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unknown tool" } });
    }
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: `echo: ${message.params?.arguments?.text ?? ""}` }] },
    });
  }
  return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
