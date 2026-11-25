/**
 * Inbound connector transport: the application dials the bridge.
 *
 * A stdio server is launched by the bridge and a Streamable HTTP server is polled over HTTP, but a
 * host application such as After Effects is already running, with its own panel UI. That panel opens
 * a WebSocket to this hub, announces itself and its tools, and then answers tool calls as they arrive.
 *
 * The hub keeps exactly one `ConnectorClient` per application. `ConnectorClient` implements the same
 * `MCPClient` interface as the stdio and HTTP transports, so `Registry` — connection state, approval,
 * permissions, idle reconnect, `/mcp`, `/v1/chat/completions` — treats a panel like any other server
 * and none of that logic had to be duplicated.
 *
 * Protocol (JSON text frames, one object per frame):
 *
 *   panel  → { "type": "register", "protocol": 1, "server": { "id", "name", "description"? },
 *              "application": { "name", "version"?, "extensionType"? }, "capabilities": [...],
 *              "tools": [{ "name", "description", "inputSchema" }] }
 *   bridge → { "type": "registered", "serverId", "approved", "status", "requireApproval" }
 *   bridge → { "type": "call", "id": 1, "name": "create-composition", "arguments": { ... } }
 *   panel  → { "type": "result", "id": 1, "ok": true, "text": "...", "structuredContent"? }
 *   panel  → { "type": "result", "id": 1, "ok": false, "error": "..." }
 *   panel  → { "type": "tools", "tools": [ ... ] }        // announce a changed tool set
 *   bridge → { "type": "error", "code", "message" }       // fatal; the socket is then closed
 *
 * Frames are size-capped, the socket is loopback-only, and an optional shared token (from
 * `MCP_BRIDGE_CONNECTOR_TOKEN`) is checked before the first message is read.
 */
import crypto from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { MCPClient } from "./client.ts";
import type { Registry } from "../registry.ts";
import type { MCPServerConfig, ServerApplication, ToolDef, ToolResult } from "../types.ts";

export const CONNECTOR_PATH = "/ws/connector";
export const CONNECTOR_PROTOCOL = 1;
const MAX_PAYLOAD = 8 * 1024 * 1024;
const REGISTER_TIMEOUT_MS = 10_000;
const MAX_TOOLS = 512;

interface PendingCall {
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ConnectorRegistration {
  server: { id: string; name: string; description?: string };
  application?: ServerApplication;
  capabilities: string[];
  tools: ToolDef[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Keeps the metadata the panel publishes so `/mcp` can pass it through like any other server. */
function normalizeTool(raw: unknown): ToolDef | null {
  if (!isObject(raw)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  const tool: ToolDef = {
    name,
    description: typeof raw.description === "string" ? raw.description : "",
    inputSchema: isObject(raw.inputSchema) ? raw.inputSchema : { type: "object", properties: {} },
  };
  if (typeof raw.title === "string" && raw.title) tool.title = raw.title;
  if (isObject(raw.outputSchema)) tool.outputSchema = raw.outputSchema;
  if (isObject(raw.annotations)) tool.annotations = raw.annotations;
  return tool;
}

/**
 * The registration is the connector's manifest: everything that would otherwise be hand-written is
 * validated here, and anything unexpected is refused rather than coerced.
 */
export function parseRegistration(raw: unknown): { ok: true; value: ConnectorRegistration } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "registration must be a JSON object" };
  if (raw.type !== "register") return { ok: false, error: "the first frame must be a register message" };
  if (Number(raw.protocol) !== CONNECTOR_PROTOCOL) {
    return { ok: false, error: `unsupported connector protocol ${String(raw.protocol)}; expected ${CONNECTOR_PROTOCOL}` };
  }
  const server = raw.server;
  if (!isObject(server)) return { ok: false, error: "server is required" };
  const id = typeof server.id === "string" ? server.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    return { ok: false, error: "server.id must be a lowercase slug (a-z, 0-9, dot, dash, underscore)" };
  }
  const name = typeof server.name === "string" ? server.name.trim() : "";
  if (!name || name.length > 120) return { ok: false, error: "server.name is required (max 120 characters)" };

  let application: ServerApplication | undefined;
  if (raw.application !== undefined) {
    if (!isObject(raw.application)) return { ok: false, error: "application must be an object" };
    const appName = typeof raw.application.name === "string" ? raw.application.name.trim() : "";
    if (!appName) return { ok: false, error: "application.name is required when application is present" };
    application = { name: appName };
    if (typeof raw.application.version === "string") application.version = raw.application.version.trim().slice(0, 40);
    if (typeof raw.application.extensionType === "string") {
      application.extensionType = raw.application.extensionType.trim().slice(0, 20);
    }
  }

  const capabilities: string[] = [];
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.length > 64) {
      return { ok: false, error: "capabilities must be an array of at most 64 strings" };
    }
    for (const entry of raw.capabilities) {
      if (typeof entry !== "string") return { ok: false, error: "capabilities must be strings" };
      const trimmed = entry.trim().slice(0, 40);
      if (trimmed) capabilities.push(trimmed);
    }
  }

  if (!Array.isArray(raw.tools)) return { ok: false, error: "tools must be an array" };
  if (raw.tools.length > MAX_TOOLS) return { ok: false, error: `at most ${MAX_TOOLS} tools may be announced` };
  const tools: ToolDef[] = [];
  const seen = new Set<string>();
  for (const candidate of raw.tools) {
    const tool = normalizeTool(candidate);
    if (!tool) return { ok: false, error: "every tool needs a non-empty name" };
    if (seen.has(tool.name)) return { ok: false, error: `duplicate tool name: ${tool.name}` };
    seen.add(tool.name);
    tools.push(tool);
  }

  return {
    ok: true,
    value: {
      server: { id, name, ...(typeof server.description === "string" ? { description: server.description.trim().slice(0, 500) } : {}) },
      ...(application ? { application } : {}),
      capabilities,
      tools,
    },
  };
}

/**
 * One live panel. Behaves like any other MCP client: `connect` resolves immediately because the
 * application is already connected; `callTool` is a request/response over the socket.
 */
export class ConnectorClient implements MCPClient {
  readonly pid = null;
  readonly resolvedCommand = null;
  private tools: ToolDef[];
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private closed = false;
  private exitHandlers: Array<(info: { code: number | null; signal: string | null; expected: boolean }) => void> = [];
  private toolsHandlers: Array<() => void> = [];

  readonly serverId: string;
  private socket: WebSocket;
  private log: (level: string, message: string) => void;

  constructor(
    serverId: string,
    socket: WebSocket,
    tools: ToolDef[],
    log: (level: string, message: string) => void = () => undefined,
  ) {
    this.serverId = serverId;
    this.socket = socket;
    this.tools = tools;
    this.log = log;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("MCP_CONNECTOR_OFFLINE: the application is not connected");
  }

  async listTools(): Promise<ToolDef[]> {
    if (this.closed) throw new Error("MCP_CONNECTOR_OFFLINE: the application is not connected");
    return this.tools;
  }

  async callTool(name: string, args: unknown, timeoutMs: number): Promise<ToolResult> {
    if (this.closed) throw new Error("MCP_CONNECTOR_OFFLINE: the application disconnected before the call");
    const id = this.nextId++;
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP_TOOL_TIMEOUT: ${name} did not answer within ${timeoutMs}ms`));
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ type: "call", id, name, arguments: args ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    this.markClosed("closed by the bridge");
    try {
      this.socket.close(1000, "bridge closed the connector");
    } catch {
      // already gone
    }
    // A panel that does not answer the close handshake must not keep the process alive.
    const socket = this.socket;
    setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // already gone
      }
    }, 500).unref();
  }

  onExit(cb: (info: { code: number | null; signal: string | null; expected: boolean }) => void): void {
    this.exitHandlers.push(cb);
  }

  onToolsChanged(cb: () => void): void {
    this.toolsHandlers.push(cb);
  }

  get connected(): boolean {
    return !this.closed;
  }

  get toolCount(): number {
    return this.tools.length;
  }

  /** Fails outstanding calls and notifies the registry once, whichever side closed the socket. */
  markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.resolve({ text: `MCP_CONNECTOR_OFFLINE: ${reason}`, isError: true });
      this.pending.delete(id);
    }
    this.log("info", reason);
    for (const handler of this.exitHandlers) handler({ code: null, signal: null, expected: true });
  }

  /** Sends a frame to the panel (used to tell it that its approval changed). */
  sendFrame(payload: unknown): void {
    if (this.closed) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // the close handler will clean up
    }
  }

  /** Handles a frame that is not a registration (results and tool-list updates). */
  handleFrame(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObject(message)) return;

    if (message.type === "result") {
      const id = Number(message.id);
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      clearTimeout(call.timer);
      if (message.ok === false) {
        call.resolve({ text: String(message.error ?? "the application reported an error"), isError: true });
        return;
      }
      const text =
        typeof message.text === "string" && message.text ? message.text : JSON.stringify(message.result ?? null);
      call.resolve({
        text,
        isError: false,
        ...(isObject(message.structuredContent) ? { structuredContent: message.structuredContent } : {}),
      });
      return;
    }

    if (message.type === "tools" && Array.isArray(message.tools)) {
      const next: ToolDef[] = [];
      for (const candidate of message.tools) {
        const tool = normalizeTool(candidate);
        if (tool) next.push(tool);
      }
      this.tools = next;
      for (const handler of this.toolsHandlers) handler();
    }
  }
}

export interface ConnectorInfo {
  path: string;
  protocol: number;
  enabled: boolean;
  tokenRequired: boolean;
  connections: Array<{
    serverId: string;
    application: ServerApplication | null;
    address: string | null;
    connectedAt: string;
    tools: number;
  }>;
  lastError: { at: string; message: string } | null;
}

export interface ConnectorDeps {
  registry: Registry;
  /** Discovery setting: a new application needs approval before it may run tools. */
  requireApproval: () => boolean;
  /** Optional shared secret from `MCP_BRIDGE_CONNECTOR_TOKEN`. */
  token?: string;
  enabled?: boolean;
  log?: (level: string, message: string) => void;
}

interface SessionMeta {
  application: ServerApplication | null;
  address: string | null;
  connectedAt: string;
}

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

function sameToken(given: string, expected: string): boolean {
  if (!expected) return true;
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export class ConnectorHub {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, ConnectorClient>();
  private meta = new Map<string, SessionMeta>();
  private lastError: { at: string; message: string } | null = null;
  private readonly enabled: boolean;
  private deps: ConnectorDeps;

  constructor(deps: ConnectorDeps) {
    this.deps = deps;
    this.enabled = deps.enabled !== false;
  }

  /** Attaches the WebSocket endpoint to the bridge's HTTP server. */
  attach(server: HttpServer): void {
    if (!this.enabled) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CONNECTOR_PATH) {
        socket.destroy();
        return;
      }
      if (!isLoopback(req)) {
        this.refuse(socket, 403, "Forbidden");
        return;
      }
      if (!sameToken(url.searchParams.get("token") ?? "", this.deps.token ?? "")) {
        this.refuse(socket, 401, "Unauthorized");
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
    });
  }

  stop(): void {
    for (const client of this.sessions.values()) {
      void client.close();
    }
    this.sessions.clear();
    this.meta.clear();
    this.wss?.close();
    this.wss = null;
  }

  /** The live client for a server id, used by `Registry` in place of launching a process. */
  take(id: string): ConnectorClient | null {
    const client = this.sessions.get(id) ?? null;
    return client && client.connected ? client : null;
  }

  info(): ConnectorInfo {
    const connections = [...this.sessions.entries()].map(([serverId, client]) => {
      const meta = this.meta.get(serverId);
      return {
        serverId,
        application: meta?.application ?? null,
        address: meta?.address ?? null,
        connectedAt: meta?.connectedAt ?? new Date().toISOString(),
        tools: client.toolCount,
      };
    });
    return {
      path: CONNECTOR_PATH,
      protocol: CONNECTOR_PROTOCOL,
      enabled: this.enabled,
      tokenRequired: Boolean(this.deps.token),
      connections,
      lastError: this.lastError,
    };
  }

  /** Tells a waiting panel that the user approved or rejected it, so its UI updates without a reload. */
  notifyApproval(id: string, approved: boolean): void {
    const client = this.sessions.get(id);
    if (!client) return;
    client.sendFrame({
      type: "registered",
      serverId: id,
      approved,
      requireApproval: this.deps.requireApproval(),
      status: this.deps.registry.view(id).status,
    });
  }

  /** Manual detach used when a server is removed or disabled while its panel is connected. */
  drop(id: string): void {
    const client = this.sessions.get(id);
    if (!client) return;
    this.sessions.delete(id);
    this.meta.delete(id);
    void client.close();
  }

  private refuse(socket: Duplex, status: number, text: string): void {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\n\r\n`);
    socket.destroy();
  }

  private accept(ws: WebSocket, req: IncomingMessage): void {
    let client: ConnectorClient | null = null;
    let registering = false;
    const address = req.socket.remoteAddress ?? null;

    const timer = setTimeout(() => {
      if (!client) ws.close(4408, "registration timeout");
    }, REGISTER_TIMEOUT_MS);
    timer.unref?.();

    ws.on("message", (data) => {
      const raw = String(data);
      if (client) {
        client.handleFrame(raw);
        return;
      }
      if (registering) return;
      registering = true;
      void this.register(raw, ws, address)
        .then((created) => {
          if (!created) return;
          client = created;
          clearTimeout(timer);
        })
        .catch((error) => {
          this.fail(ws, "MCP_CONNECTOR_ERROR", error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          registering = false;
        });
    });

    ws.on("close", () => {
      clearTimeout(timer);
      if (!client) return;
      const id = client.serverId;
      client.markClosed("application closed the connector");
      if (this.sessions.get(id) === client) {
        this.sessions.delete(id);
        this.meta.delete(id);
        this.deps.registry.connectorReset(id);
      }
    });

    ws.on("error", () => {
      // `close` follows and does the bookkeeping.
    });
  }

  private async register(raw: string, ws: WebSocket, address: string | null): Promise<ConnectorClient | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.fail(ws, "MCP_CONNECTOR_INVALID", "registration frame was not valid JSON");
      return null;
    }
    const result = parseRegistration(parsed);
    if (!result.ok) {
      this.fail(ws, "MCP_CONNECTOR_INVALID", result.error);
      return null;
    }
    const registration = result.value;
    const id = registration.server.id;
    const existing = this.deps.registry.find(id);
    if (existing && existing.transport !== "connector") {
      this.fail(
        ws,
        "MCP_CONNECTOR_CONFLICT",
        `server id "${id}" is already used by a ${existing.transport} server; rename the application's id`,
      );
      return null;
    }

    const approved = this.deps.registry.registerConnector(registration, !this.deps.requireApproval());
    const client = new ConnectorClient(id, ws, registration.tools, this.deps.log);
    // The socket is the server now: whatever runtime the previous one left behind is stale.
    this.deps.registry.connectorReset(id);

    const previous = this.sessions.get(id);
    this.sessions.set(id, client);
    this.meta.set(id, {
      application: registration.application ?? null,
      address,
      connectedAt: new Date().toISOString(),
    });
    if (previous && previous !== client) {
      // A reloaded panel supersedes its old socket instead of leaving a dead session behind.
      void previous.close();
    }

    ws.send(
      JSON.stringify({
        type: "registered",
        serverId: id,
        approved,
        requireApproval: this.deps.requireApproval(),
        status: this.deps.registry.view(id).status,
      }),
    );

    // Held for approval: `connectorReset` put it in `pending_approval`, and the socket stays
    // open so approving it connects without the user reopening the panel.
    if (!approved) return client;

    try {
      await this.deps.registry.connect(id);
      this.lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = { at: new Date().toISOString(), message };
      this.deps.log?.("error", `connector ${id} failed to connect: ${message}`);
      ws.send(JSON.stringify({ type: "error", code: "MCP_CONNECTOR_CONNECT_FAILED", message }));
    }
    return client;
  }

  private fail(ws: WebSocket, code: string, message: string): void {
    this.lastError = { at: new Date().toISOString(), message };
    this.deps.log?.("error", `${code}: ${message}`);
    try {
      ws.send(JSON.stringify({ type: "error", code, message }));
      ws.close(4400, code);
    } catch {
      // socket already gone
    }
  }
}
