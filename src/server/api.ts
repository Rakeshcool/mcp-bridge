import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventEmitter } from "node:events";
import { CLIENT_DIR } from "./paths.ts";
import { ApiError, validateServerInput } from "./validate.ts";
import { authRef, deleteServerSecrets, envRef, getSecret, headerRef, setSecret } from "./secrets.ts";
import type { Registry } from "./registry.ts";
import type { ApprovalService } from "./approvals.ts";
import type { ActivityStore } from "./activity.ts";
import type { BridgeSettings, HttpConnection, MCPServerConfig, StdioConnection, ToolResult } from "./types.ts";
import { runChat } from "./bridge.ts";
import { MCP_ENDPOINT_PATH } from "./mcp/server.ts";
import { PROTOCOL_VERSION } from "./mcp/client.ts";
import { upstreamStatus } from "./upstream.ts";
import { DEFAULT_PORT } from "./constants.ts";

export interface ApiContext {
  registry: Registry;
  events: EventEmitter;
  approvals: ApprovalService;
  activity: ActivityStore;
  getSettings: () => BridgeSettings;
  setSettings: (settings: BridgeSettings) => void;
}

const MASK = "••••";
const MAX_BODY = 1_048_576;

// Raised by Registry.callTool when the server stopped between discovery and the call.
function isNotConnected(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("MCP_SERVER_NOT_CONNECTED");
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details ?? null } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]{3,}):\s*([\s\S]*)$/.exec(message);
  sendJson(res, 500, {
    error: { code: match ? match[1] : "MCP_INTERNAL_ERROR", message: match ? match[2] : message },
  });
}

async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new ApiError("MCP_INVALID_CONFIG", "Request body too large", 413);
    chunks.push(buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("MCP_INVALID_CONFIG", "Request body was not valid JSON");
  }
}

function serverView(server: MCPServerConfig, registry: Registry): Record<string, unknown> {
  const runtime = registry.view(server.id);
  let connection: Record<string, unknown>;
  if (server.transport === "stdio") {
    const conn = server.connection as StdioConnection;
    connection = {
      command: conn.command,
      args: conn.args ?? [],
      cwd: conn.cwd ?? "",
      env: conn.env ?? {},
      secretEnv: conn.secretEnv ?? [],
    };
  } else {
    const conn = server.connection as HttpConnection;
    connection = {
      url: conn.url,
      headers: conn.headers ?? {},
      secretHeaders: conn.secretHeaders ?? [],
      authType: conn.auth ? "bearer" : "none",
      hasToken: Boolean(getSecret(authRef(server.id))),
      verifyTls: conn.verifyTls !== false,
    };
  }
  return {
    id: server.id,
    name: server.name,
    description: server.description ?? "",
    enabled: server.enabled,
    visibility: server.visibility,
    transport: server.transport,
    connection,
    startupTimeoutMs: server.startupTimeoutMs ?? 30000,
    toolTimeoutMs: server.toolTimeoutMs ?? 60000,
    idleTimeoutMs: server.idleTimeoutMs ?? 0,
    restartPolicy: server.restartPolicy ?? "on_failure",
    runtime,
    logs: registry.logs(server.id).slice(-60),
  };
}

function extractSecrets(raw: any, id: string): void {
  const connection = raw?.connection ?? {};
  if (raw?.transport === "stdio") {
    const env = connection.env && typeof connection.env === "object" ? connection.env : {};
    for (const key of Array.isArray(connection.secretEnv) ? connection.secretEnv : []) {
      const value = env[key];
      if (typeof value === "string" && value && value !== MASK) setSecret(envRef(id, key), value);
      delete env[key];
    }
  } else {
    const headers = connection.headers && typeof connection.headers === "object" ? connection.headers : {};
    for (const key of Array.isArray(connection.secretHeaders) ? connection.secretHeaders : []) {
      const value = headers[key];
      if (typeof value === "string" && value && value !== MASK) setSecret(headerRef(id, key), value);
      delete headers[key];
    }
    if (typeof connection.token === "string" && connection.token && connection.token !== MASK) {
      setSecret(authRef(id), connection.token);
    }
    delete connection.token;
  }
}

async function handleServerRoutes(req: IncomingMessage, res: ServerResponse, segments: string[], ctx: ApiContext): Promise<boolean> {
  const registry = ctx.registry;
  const [id, action, sub] = [segments[0], segments[1], segments[2]];
  if (!id) return false;

  if (!action) {
    if (req.method === "GET") {
      const server = registry.find(id);
      if (!server) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
      sendJson(res, 200, { server: serverView(server, registry) });
      return true;
    }
    if (req.method === "PUT") {
      const server = registry.find(id);
      if (!server) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
      const raw = await readJson(req);
      raw.id = id;
      extractSecrets(raw, id);
      const next = validateServerInput({ ...raw, createdAt: server.createdAt }, [], false);
      next.id = id;
      // The editor does not send per-tool settings; keep whatever the Tools tab configured.
      if (!raw.tools && server.tools) next.tools = server.tools;
      const wasConnected = registry.view(id).status === "connected";
      registry.replaceServer(next);
      if (!next.enabled) {
        if (wasConnected) await registry.disconnect(id);
      } else if (wasConnected) {
        // Command, transport or timeouts may have changed: restart so the running
        // process actually matches the stored configuration.
        try {
          await registry.restart(id);
        } catch {
          // The restart failure is already recorded in the server's status and logs.
        }
      }
      sendJson(res, 200, { server: serverView(next, registry) });
      return true;
    }
    if (req.method === "DELETE") {
      await registry.removeServer(id);
      deleteServerSecrets(id);
      sendJson(res, 200, { ok: true, id });
      return true;
    }
    return false;
  }

  if (action === "connect" && req.method === "POST") {
    const view = await registry.connect(id);
    sendJson(res, 200, { ok: true, runtime: view });
    return true;
  }
  if (action === "disconnect" && req.method === "POST") {
    const view = await registry.disconnect(id);
    sendJson(res, 200, { ok: true, runtime: view });
    return true;
  }
  if (action === "restart" && req.method === "POST") {
    const view = await registry.restart(id);
    sendJson(res, 200, { ok: true, runtime: view });
    return true;
  }
  if (action === "enable" && req.method === "POST") {
    const raw = await readJson(req);
    registry.setEnabled(id, raw.enabled !== false);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (action === "test" && req.method === "POST") {
    const before = registry.view(id).status;
    const runtime = await registry.connect(id);
    if (before !== "connected") await registry.disconnect(id);
    sendJson(res, 200, { ok: true, tools: runtime.toolCount, status: runtime.status });
    return true;
  }
  if (action === "logs") {
    if (req.method === "GET") {
      sendJson(res, 200, { logs: registry.logs(id) });
      return true;
    }
    if (req.method === "DELETE") {
      registry.clearLogs(id);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }
  if (action === "tools") {
    if (!sub && req.method === "GET") {
      sendJson(res, 200, { tools: registry.view(id).tools });
      return true;
    }
    if (sub === "refresh" && req.method === "POST") {
      const tools = await registry.refreshTools(id);
      sendJson(res, 200, { ok: true, tools });
      return true;
    }
  }
  return false;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiContext): Promise<void> {
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) {
      throw new ApiError("MCP_FORBIDDEN_ORIGIN", "Cross-origin management requests are not allowed", 403);
    }
  }

  try {
    if (parts[0] === "state" && req.method === "GET") {
      const settings = ctx.getSettings();
      const servers = ctx.registry.servers.map((server) => serverView(server, ctx.registry));
      sendJson(res, 200, {
        servers,
        bridge: settings,
        upstream: await upstreamStatus(settings.baseUrl),
        approvals: ctx.approvals.list(),
        activity: ctx.activity.list().slice(0, 25),
        catalog: ctx.registry.catalog(),
        mcp: { path: MCP_ENDPOINT_PATH, protocolVersion: PROTOCOL_VERSION, transport: "streamable-http", sse: false },
        platform: process.platform,
      });
      return;
    }

    if (parts[0] === "bridge") {
      if (req.method === "GET") {
        const settings = ctx.getSettings();
        sendJson(res, 200, { settings, upstream: await upstreamStatus(settings.baseUrl), activity: ctx.activity.list().slice(0, 25) });
        return;
      }
      if (req.method === "PUT") {
        const raw = await readJson(req);
        const current = ctx.getSettings();
        const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : current.baseUrl;
        let parsed: URL;
        try {
          parsed = new URL(baseUrl);
        } catch {
          throw new ApiError("MCP_INVALID_CONFIG", "baseUrl must be a valid URL");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new ApiError("MCP_INVALID_CONFIG", "baseUrl must use http or https");
        }
        const next: BridgeSettings = {
          baseUrl: parsed.toString().replace(/\/$/, ""),
          model: typeof raw.model === "string" ? raw.model : current.model,
          maxRounds: Math.min(Math.max(Number(raw.maxRounds ?? current.maxRounds) || 1, 1), 12),
          toolTimeoutMs: Math.min(Math.max(Number(raw.toolTimeoutMs ?? current.toolTimeoutMs) || 1000, 1000), 600000),
          requestTimeoutMs: Math.min(Math.max(Number(raw.requestTimeoutMs ?? current.requestTimeoutMs) || 30000, 5000), 1800000),
        };
        ctx.setSettings(next);
        sendJson(res, 200, { settings: next, upstream: await upstreamStatus(next.baseUrl) });
        return;
      }
    }

    if (parts[0] === "servers") {
      if (parts.length === 1) {
        if (req.method === "GET") {
          sendJson(res, 200, { servers: ctx.registry.servers.map((server) => serverView(server, ctx.registry)) });
          return;
        }
        if (req.method === "POST") {
          const raw = await readJson(req);
          if (!raw?.id && typeof raw?.name === "string") raw.id = raw.name;
          const provisionalId = validateServerInput({ ...raw, id: raw?.id ?? raw?.name ?? "server" }, [], false).id;
          extractSecrets(raw, provisionalId);
          const config = validateServerInput(
            raw,
            ctx.registry.servers.map((server) => server.id),
            true,
          );
          ctx.registry.replaceServer(config);
          sendJson(res, 201, { server: serverView(config, ctx.registry) });
          return;
        }
      } else if (await handleServerRoutes(req, res, parts.slice(1), ctx)) {
        return;
      }
    }

    if (parts[0] === "tools") {
      if (parts.length === 1 && req.method === "GET") {
        sendJson(res, 200, { tools: ctx.registry.catalog() });
        return;
      }
      if (parts.length === 2 && req.method === "PATCH") {
        const exposedName = decodeURIComponent(parts[1]);
        const raw = await readJson(req);
        if (raw.permission !== undefined && !["allow", "ask", "deny"].includes(raw.permission)) {
          throw new ApiError("MCP_INVALID_CONFIG", `Invalid permission: ${JSON.stringify(raw.permission)}`, 400, {
            allowed: ["allow", "ask", "deny"],
          });
        }
        if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
          throw new ApiError("MCP_INVALID_CONFIG", "enabled must be a boolean", 400);
        }
        const entry = ctx.registry.patchTool(exposedName, {
          enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
          permission: raw.permission,
        });
        sendJson(res, 200, { tool: entry });
        return;
      }
      // Direct tool invocation: no model, no llama.cpp. The body is either the argument
      // object itself or {"arguments": {...}}.
      if (parts.length === 3 && parts[2] === "call" && req.method === "POST") {
        const exposedName = decodeURIComponent(parts[1]);
        // Reconnects the owning server when an idle stop hid the tool from the catalog.
        const resolved = await ctx.registry.resolveDirectTool(exposedName);
        if (!resolved) {
          throw new ApiError(
            "MCP_TOOL_NOT_FOUND",
            `Unknown tool: ${exposedName}. Read GET /api/tools for exposed names; tools of idle-stopped servers are reconnected automatically on the next direct call.`,
            404,
          );
        }
        const entry = resolved.entry;
        let reconnected = resolved.reconnected;
        if (!entry.enabled) throw new ApiError("MCP_PERMISSION_DENIED", `Tool ${exposedName} is disabled`, 403);
        if (entry.permission !== "allow") {
          throw new ApiError(
            "MCP_PERMISSION_DENIED",
            `Tool ${exposedName} is set to "${entry.permission}"; only "allow" tools accept direct calls`,
            403,
            { permission: entry.permission },
          );
        }
        const raw = await readJson(req);
        const args = raw && typeof raw === "object" && "arguments" in raw ? (raw as Record<string, unknown>).arguments : raw;
        const server = ctx.registry.find(entry.serverId);
        const timeoutMs = server?.toolTimeoutMs ?? 60000;
        const startedAt = Date.now();
        let result: ToolResult;
        try {
          result = await ctx.registry.callTool(entry.serverId, entry.toolName, args ?? {}, timeoutMs);
        } catch (error) {
          // The server can idle-stop in the gap between discovery and the call itself.
          // Reconnect once and retry, rather than handing the caller a dead end.
          if (reconnected || !isNotConnected(error)) throw error;
          await ctx.registry.connect(entry.serverId);
          reconnected = true;
          result = await ctx.registry.callTool(entry.serverId, entry.toolName, args ?? {}, timeoutMs);
        }
        sendJson(res, 200, {
          ok: !result.isError,
          tool: exposedName,
          serverId: entry.serverId,
          toolName: entry.toolName,
          durationMs: Date.now() - startedAt,
          isError: result.isError,
          // True when the call only succeeded after reconnecting an idle-stopped server.
          ...(reconnected ? { reconnected: true } : {}),
          result: result.text,
          // Image blocks are returned as data URLs so a CLI, panel or model can
          // actually look at them instead of a "[image omitted]" placeholder.
          ...(result.images?.length
            ? {
                images: result.images.map((image: { mimeType: string; data: string }) => ({
                  mimeType: image.mimeType,
                  dataUrl: `data:${image.mimeType};base64,${image.data}`,
                })),
              }
            : {}),
        });
        return;
      }
    }

    if (parts[0] === "activity" && req.method === "GET") {
      sendJson(res, 200, { activity: ctx.activity.list() });
      return;
    }

    if (parts[0] === "approvals") {
      if (parts.length === 1 && req.method === "GET") {
        sendJson(res, 200, { approvals: ctx.approvals.list() });
        return;
      }
      if (parts.length === 2 && req.method === "POST") {
        const raw = await readJson(req);
        const resolved = ctx.approvals.resolve(parts[1], raw.approved === true);
        if (!resolved) throw new ApiError("MCP_APPROVAL_NOT_FOUND", "That approval is no longer pending", 404);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (parts[0] === "chat" && req.method === "POST") {
      const raw = await readJson(req);
      const result = await runChat({
        body: { ...raw, stream: false },
        registry: ctx.registry,
        settings: ctx.getSettings(),
        approvals: ctx.approvals,
        activity: ctx.activity,
      });
      sendJson(res, 200, {
        content: result.content,
        activity: result.activity,
        usage: result.response.usage,
      });
      return;
    }

    if (parts[0] === "events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const onEvent = (event: { type: string; data: unknown }) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      };
      ctx.events.on("event", onEvent);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => {
        clearInterval(heartbeat);
        ctx.events.off("event", onEvent);
      });
      return;
    }

    throw new ApiError("MCP_NOT_FOUND", `Unknown API route: ${url.pathname}`, 404);
  } catch (error) {
    sendError(res, error);
  }
}

export async function handleBridge(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiContext): Promise<void> {
  const settings = ctx.getSettings();
  const target = new URL(url.pathname + url.search, settings.baseUrl.endsWith("/") ? settings.baseUrl : `${settings.baseUrl}/`);

  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    try {
      const body = await readJson(req, 32 * 1024 * 1024);
      const result = await runChat({
        body,
        registry: ctx.registry,
        settings,
        approvals: ctx.approvals,
        activity: ctx.activity,
      });
      if (body.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const id = String(result.response.id);
        const created = Number(result.response.created);
        const model = String(result.response.model);
        const base = { id, object: "chat.completion.chunk", created, model };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        const text = result.content;
        const size = 120;
        for (let offset = 0; offset < text.length; offset += size) {
          res.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text.slice(offset, offset + size) }, finish_reason: null }] })}\n\n`,
          );
        }
        const choice = (result.response as any).choices?.[0];
        const finishReason = String(choice?.finish_reason ?? "stop");
        const toolCalls = choice?.message?.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length) {
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
            })}\n\n`,
          );
        }
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: result.response.usage,
            x_mcp_bridge: result.response.x_mcp_bridge,
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      sendJson(res, 200, result.response);
      return;
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, error);
      return;
    }
  }

  // Everything else is a transparent proxy to llama-server.
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const upstream = await fetch(target, {
      method: req.method,
      headers: { "content-type": String(req.headers["content-type"] ?? "application/json") },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      signal: AbortSignal.timeout(120000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      "content-length": body.length,
    });
    res.end(body);
  } catch (error) {
    sendError(res, error);
  }
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const indexFile = path.join(CLIENT_DIR, "index.html");
  if (!fs.existsSync(indexFile)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Panel not built yet. Run: bun run build\n");
    return;
  }
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(requested).replace(/^([/\\])+/, "");
  const filePath = path.join(CLIENT_DIR, safePath);
  if (!filePath.startsWith(CLIENT_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const body = fs.readFileSync(indexFile);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
    res.end(body);
    return;
  }
  const extension = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
  };
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "content-type": types[extension] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": extension === ".html" ? "no-store" : "public, max-age=60",
  });
  res.end(body);
}

export function checkHost(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? "");
  const hostname = host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || host === "";
}

export function portOf(host: string): number {
  const match = /:(\d+)$/.exec(host);
  return match ? Number(match[1]) : DEFAULT_PORT;
}
