// Minimal MCP stdio server used by the endpoint tests: an echo tool, an image tool, a tool that
// reports an error, and nothing that keeps the process alive once stdin closes.
import process from "node:process";

/** 1x1 transparent PNG, small enough to compare byte for byte. */
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const tools = [
  {
    name: "say",
    description: "Echo the text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "shot",
    description: "Return a tiny image next to some text",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "boom",
    description: "Report an error result",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "report",
    title: "Report",
    description: "Return a structured report",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
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
    const name = message.params?.name;
    if (name === "say") {
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `echo: ${message.params?.arguments?.text ?? ""}` }] },
      });
    }
    if (name === "shot") {
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            { type: "text", text: "shot" },
            { type: "image", data: PNG, mimeType: "image/png" },
          ],
        },
      });
    }
    if (name === "boom") {
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "boom" }], isError: true },
      });
    }
    if (name === "report") {
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "answer: 42" }],
          structuredContent: { answer: 42 },
        },
      });
    }
    return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool: ${name}` } });
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
