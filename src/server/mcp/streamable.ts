import http from "node:http";
import https from "node:https";
import type { HttpConnection, MCPServerConfig, ToolDef, ToolResult } from "../types.ts";
import { initializeParams, normalizeTool, normalizeToolResult } from "./client.ts";
import type { MCPClient, MCPClientOptions } from "./client.ts";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function hostKey(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function sendOnce(url: URL, method: string, body: string | null, headers: Record<string, string>, timeoutMs: number, verifyTls: boolean): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers,
      rejectUnauthorized: verifyTls !== false,
    };
    const request = lib.request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(`MCP_CONNECTION_TIMEOUT: no response within ${timeoutMs}ms`)));
    request.on("error", reject);
    request.setTimeout(timeoutMs);
    if (body !== null) request.write(body);
    request.end();
  });
}

/** Parses an SSE body for the JSON-RPC message with the requested id (or the last message). */
function pickFromSse(body: string, expectedId: number): unknown {
  const events = body.split(/\r?\n\r?\n/);
  let fallback: unknown = undefined;
  for (const event of events) {
    const dataLines: string[] = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") continue;
    let message: any;
    try {
      message = JSON.parse(payload);
    } catch {
      continue;
    }
    fallback = message;
    if (message && typeof message === "object" && Number(message.id) === expectedId) return message;
  }
  return fallback;
}

export class StreamableHttpClient implements MCPClient {
  pid: number | null = null;
  private config: MCPServerConfig;
  private opts: MCPClientOptions;
  private headers: Record<string, string>;
  private sessionId: string | null = null;
  private nextId = 1;
  private connected = false;

  constructor(config: MCPServerConfig, opts: MCPClientOptions, headers: Record<string, string>) {
    this.config = config;
    this.opts = opts;
    this.headers = headers;
  }

  onExit(cb: (info: { code: number | null; signal: string | null; expected: boolean }) => void): void {
    this.opts.onExit = cb;
  }

  onToolsChanged(cb: () => void): void {
    this.opts.onToolsChanged = cb;
  }

  async connect(): Promise<void> {
    const conn = this.config.connection as HttpConnection;
    if (!conn.url) throw new Error("MCP_INVALID_CONFIG: url is required");
    this.opts.log("info", `connecting to ${conn.url}`);
    await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: initializeParams() }, this.opts.startupTimeoutMs);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, 15000, true);
    this.connected = true;
  }

  async listTools(): Promise<ToolDef[]> {
    const result = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} }, this.opts.startupTimeoutMs);
    const rawTools = Array.isArray((result as any)?.tools) ? (result as any).tools : [];
    return rawTools.map(normalizeTool);
  }

  async callTool(name: string, args: unknown, timeoutMs: number): Promise<ToolResult> {
    const result = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args ?? {} } }, timeoutMs);
    return normalizeToolResult(result);
  }

  async close(): Promise<void> {
    const conn = this.config.connection as HttpConnection;
    if (this.connected && this.sessionId) {
      try {
        const url = new URL(conn.url);
        await sendOnce(url, "DELETE", null, { ...this.baseHeaders(), "mcp-session-id": this.sessionId }, 10000, conn.verifyTls !== false);
      } catch {
        // best effort
      }
    }
    this.connected = false;
    this.sessionId = null;
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    };
    for (const [key, value] of Object.entries(this.headers)) headers[key.toLowerCase()] = value;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async post(payload: Record<string, unknown>, timeoutMs: number, notification = false): Promise<unknown> {
    const conn = this.config.connection as HttpConnection;
    let url = new URL(conn.url);
    const headers = this.baseHeaders();
    const body = JSON.stringify(payload);
    const expectedId = Number(payload.id ?? -1);

    for (let hop = 0; hop < 4; hop++) {
      const response = await sendOnce(url, "POST", body, headers, timeoutMs, conn.verifyTls !== false);
      const session = response.headers["mcp-session-id"];
      if (typeof session === "string" && session) this.sessionId = session;

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        if (!location) throw new Error(`MCP_PROTOCOL_ERROR: HTTP ${response.status} without a Location header`);
        const next = new URL(location, url);
        if (hostKey(next) !== hostKey(url)) {
          throw new Error("MCP_PROTOCOL_ERROR: refusing to follow a redirect to a different origin");
        }
        url = next;
        continue;
      }

      if (response.status === 202 || response.status === 204) {
        if (notification) return null;
        return {};
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`MCP_PROTOCOL_ERROR: HTTP ${response.status} ${response.body.slice(0, 300)}`);
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (contentType.includes("text/event-stream")) {
        const message = pickFromSse(response.body, expectedId) as any;
        if (message?.error) throw new Error(`MCP_PROTOCOL_ERROR: ${message.error?.message ?? "unknown error"}`);
        return message?.result ?? {};
      }
      let parsed: any = null;
      try {
        parsed = response.body ? JSON.parse(response.body) : null;
      } catch {
        throw new Error(`MCP_PROTOCOL_ERROR: response was not JSON (${contentType || "unknown content type"})`);
      }
      if (parsed?.error) throw new Error(`MCP_PROTOCOL_ERROR: ${parsed.error?.message ?? "unknown error"}`);
      return parsed?.result ?? parsed ?? {};
    }
    throw new Error("MCP_PROTOCOL_ERROR: too many redirects");
  }
}
