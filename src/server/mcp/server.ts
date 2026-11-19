import type { IncomingMessage, ServerResponse } from "node:http";
import type { Registry } from "../registry.ts";
import type { ApprovalService } from "../approvals.ts";
import type { ActivityStore, RoundRecord, StoredImage } from "../activity.ts";
import type { BridgeSettings, ToolResult } from "../types.ts";
import { validateToolSchema } from "../validate.ts";
import { PROTOCOL_VERSION } from "./client.ts";

/**
 * The bridge is an MCP *client* for every server it owns. This module is the other side of that
 * relationship: one aggregated MCP server at `/mcp` so any MCP client — Claude Code, Codex,
 * Cursor, another agent — gets the whole catalog with the bridge's namespacing, permissions,
 * idle reconnects and activity log, instead of configuring every server again.
 *
 * Transport is Streamable HTTP in its simplest conforming shape: JSON responses to POST, and no
 * server-initiated SSE stream (GET answers 405, which the spec allows). The endpoint is stateless:
 * nothing is stored per client, so no session id is issued, any `mcp-session-id` is ignored, and
 * `DELETE` is accepted without closing anything.
 */
export const MCP_ENDPOINT_PATH = "/mcp";

const SERVER_INFO = { name: "llama-mcp-bridge", version: "0.1.0" };
/** Versions this subset of the protocol satisfies; anything else is answered with our own. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export interface McpEndpointContext {
  registry: Registry;
  approvals: ApprovalService;
  activity: ActivityStore;
  getSettings: () => BridgeSettings;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: any;
}

class RpcFailure extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function errorResponse(id: unknown, failure: RpcFailure): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.data === undefined ? {} : { data: failure.data }),
    },
  };
}

/** The whole body, so a 202/405 reply is never left draining an unread request stream. */
async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new RpcFailure(-32600, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RpcFailure(-32700, "Parse error: the request body is not valid JSON");
  }
}

function initializeResult(params: any): Record<string, unknown> {
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions:
      "Tools from every connected MCP server, named serverId__toolName. allow-level tools run immediately; " +
      "ask-level calls wait for an approval in the bridge panel; deny-level calls are refused. A server that " +
      "idle-stopped is reconnected on the next call, so MCP_TOOL_NOT_FOUND only means the name does not exist.",
  };
}

async function callTool(params: any, ctx: McpEndpointContext): Promise<Record<string, unknown>> {
  const name = typeof params?.name === "string" ? params.name : "";
  if (!name) throw new RpcFailure(-32602, "tools/call requires params.name");
  const rawArgs = params.arguments;
  if (rawArgs != null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
    throw new RpcFailure(-32602, "tools/call params.arguments must be an object");
  }
  const args = rawArgs ?? {};

  const resolved = await ctx.registry.resolveDirectTool(name);
  if (!resolved) {
    throw new RpcFailure(-32602, `Unknown tool: ${name}`, {
      hint: "Call tools/list for exposed names. Tools of a stopped server are missing until it reconnects.",
    });
  }
  const entry = resolved.entry;

  const record = ctx.activity.create({ model: "mcp-endpoint", stream: false, injectedTools: 0 });
  const round: RoundRecord = { index: 0, finishReason: "tool_calls", toolCalls: [], assistantChars: 0 };
  record.rounds.push(round);
  const startedAt = Date.now();
  const note = (status: "ok" | "error" | "denied", text: string, images?: StoredImage[]) => {
    round.toolCalls.push({
      name,
      serverId: entry.serverId,
      toolName: entry.toolName,
      args: JSON.stringify(args).slice(0, 400),
      permission: entry.permission,
      status,
      durationMs: Date.now() - startedAt,
      result: text,
      ...(images?.length ? { images } : {}),
    });
  };

  let denial = !entry.enabled
    ? `Tool ${name} is disabled in the bridge panel.`
    : entry.permission === "deny"
      ? `Permission denied: ${name} is set to Deny in the bridge panel, so this endpoint never runs it.`
      : null;
  if (!denial && entry.permission === "ask") {
    const approved = await ctx.approvals.request({
      serverId: entry.serverId,
      serverName: entry.serverName,
      tool: entry.toolName,
      exposedName: name,
      args: JSON.stringify(args).slice(0, 600),
    });
    if (!approved) denial = "Permission denied: the user declined this tool call. Do not retry it without asking.";
  }
  if (denial) {
    note("denied", denial);
    ctx.activity.finish(record);
    return { content: [{ type: "text", text: denial }], isError: true };
  }

  let result: ToolResult;
  try {
    result = await ctx.registry.callTool(entry.serverId, entry.toolName, args, ctx.getSettings().toolTimeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note("error", message);
    ctx.activity.finish(record, message);
    return { content: [{ type: "text", text: `Tool execution failed: ${message}` }], isError: true };
  }

  note(
    result.isError ? "error" : "ok",
    result.text.slice(0, 800),
    (result.images ?? [])
      .slice(0, 2)
      .map((image) => ({ mimeType: image.mimeType, dataUrl: `data:${image.mimeType};base64,${image.data}` })),
  );
  ctx.activity.finish(record, result.isError ? "tool reported an error" : undefined);

  const content: Array<Record<string, unknown>> = [{ type: "text", text: result.text || "(no output)" }];
  for (const image of result.images ?? []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return result.isError ? { content, isError: true } : { content };
}

async function dispatch(message: JsonRpcMessage, ctx: McpEndpointContext): Promise<unknown> {
  switch (message.method) {
    case "initialize":
      return initializeResult(message.params);
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: ctx.registry
          .injectable()
          .filter((entry) => entry.visibility !== "hidden_until_mentioned")
          .map((entry) => ({
            name: entry.exposedName,
            description: entry.description || `${entry.toolName} (from ${entry.serverName})`,
            inputSchema: validateToolSchema(entry.inputSchema),
          })),
      };
    case "tools/call":
      return callTool(message.params, ctx);
    default:
      throw new RpcFailure(-32601, `Method not found: ${String(message.method)}`);
  }
}

/** Entry point for `/mcp`: JSON-RPC over POST, plus the GET/DELETE answers a Streamable HTTP client expects. */
export async function handleMcpEndpoint(req: IncomingMessage, res: ServerResponse, ctx: McpEndpointContext): Promise<void> {
  const origin = req.headers.origin;
  if (origin && !LOOPBACK_ORIGIN.test(String(origin))) {
    sendJson(res, 403, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Cross-origin MCP requests are not allowed; connect from this machine." },
    });
    return;
  }

  if (req.method === "DELETE") {
    // Accepted for spec completeness: this endpoint keeps no session state, so there is nothing to close.
    sendJson(res, 200, { jsonrpc: "2.0", result: {} });
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST, DELETE", "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(
      req.method === "GET" || req.method === "HEAD"
        ? "This endpoint serves MCP over POST only; it does not open a server-initiated SSE stream.\n"
        : "",
    );
    return;
  }

  let message: any;
  try {
    message = await readJsonBody(req);
  } catch (error) {
    const failure = error instanceof RpcFailure ? error : new RpcFailure(-32700, (error as Error).message);
    sendJson(res, 200, errorResponse(null, failure));
    return;
  }

  if (Array.isArray(message)) {
    sendJson(res, 200, errorResponse(null, new RpcFailure(-32600, "Batch requests are not supported; send one message per request")));
    return;
  }
  if (
    !message ||
    typeof message !== "object" ||
    typeof message.method !== "string" ||
    !message.method ||
    (message.jsonrpc !== undefined && message.jsonrpc !== "2.0")
  ) {
    sendJson(res, 200, errorResponse(message?.id, new RpcFailure(-32600, "Invalid JSON-RPC request: expected {\"jsonrpc\":\"2.0\", method, id}")));
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    // Notifications (notifications/initialized, notifications/cancelled, …) need no reply.
    res.writeHead(202, { "cache-control": "no-store" });
    res.end();
    return;
  }

  try {
    sendJson(res, 200, { jsonrpc: "2.0", id: message.id, result: await dispatch(message, ctx) });
  } catch (error) {
    const failure = error instanceof RpcFailure ? error : new RpcFailure(-32603, (error as Error).message || "Internal error");
    sendJson(res, 200, errorResponse(message.id, failure));
  }
}
