import type { EventEmitter } from "node:events";
import { LogBuffer } from "./logs.ts";
import type { LogEntry } from "./logs.ts";
import { StdioClient } from "./mcp/stdio.ts";
import { StreamableHttpClient } from "./mcp/streamable.ts";
import type { MCPClient } from "./mcp/client.ts";
import { authRef, envRef, getSecret, headerRef } from "./secrets.ts";
import { ApiError } from "./validate.ts";
import type {
  HttpConnection,
  MCPServerConfig,
  MCPStatus,
  PermissionMode,
  ServerRuntimeView,
  StdioConnection,
  ToolDef,
  ToolResult,
  ToolView,
  Visibility,
} from "./types.ts";

interface Runtime {
  status: MCPStatus;
  pid: number | null;
  lastConnected: string | null;
  connectedAt: string | null;
  lastError: string | null;
  tools: ToolDef[];
  calls: number;
  logs: LogBuffer;
  client: MCPClient | null;
  attempts: number;
  reconnectTimer: NodeJS.Timeout | null;
}

export interface CatalogEntry {
  serverId: string;
  serverName: string;
  visibility: Visibility;
  toolName: string;
  exposedName: string;
  description: string;
  inputSchema: unknown;
  enabled: boolean;
  permission: PermissionMode;
}

/** Raised by `callTool` when the server stopped between discovery and the call. */
export function isNotConnected(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("MCP_SERVER_NOT_CONNECTED");
}

function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "tool";
}

export class Registry {
  servers: MCPServerConfig[];
  private events: EventEmitter;
  private runtimes = new Map<string, Runtime>();
  private persist: () => void;

  constructor(servers: MCPServerConfig[], events: EventEmitter, persist: () => void) {
    this.servers = servers;
    this.events = events;
    this.persist = persist;
    for (const server of servers) this.runtimes.set(server.id, this.blankRuntime(server));
  }

  private blankRuntime(server: MCPServerConfig): Runtime {
    return {
      status: server.enabled ? "disconnected" : "disabled",
      pid: null,
      lastConnected: null,
      connectedAt: null,
      lastError: null,
      tools: [],
      calls: 0,
      logs: new LogBuffer(250),
      client: null,
      attempts: 0,
      reconnectTimer: null,
    };
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      const server = this.find(id);
      runtime = this.blankRuntime(server ?? ({ enabled: true } as MCPServerConfig));
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  find(id: string): MCPServerConfig | undefined {
    return this.servers.find((server) => server.id === id);
  }

  private emit(type: string, data: unknown): void {
    this.events.emit("event", { type, data });
  }

  replaceServer(server: MCPServerConfig): void {
    const index = this.servers.findIndex((entry) => entry.id === server.id);
    if (index >= 0) this.servers[index] = server;
    else this.servers.push(server);
    this.persist();
    this.emit("status", { serverId: server.id });
    this.emit("tools", { serverId: server.id });
  }

  async removeServer(id: string): Promise<void> {
    if (!this.find(id)) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
    const runtime = this.runtimes.get(id);
    if (runtime?.client) {
      try {
        await runtime.client.close();
      } catch {
        // best effort
      }
    }
    if (runtime?.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    this.runtimes.delete(id);
    this.servers = this.servers.filter((server) => server.id !== id);
    this.persist();
    this.emit("status", { serverId: id, removed: true });
    this.emit("tools", { serverId: id, removed: true });
  }

  setEnabled(id: string, enabled: boolean): void {
    const server = this.find(id);
    if (!server) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
    server.enabled = enabled;
    server.updatedAt = nowIso();
    const runtime = this.runtime(id);
    if (!enabled) {
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
      if (runtime.client) void this.disconnect(id).catch(() => undefined);
      runtime.status = "disabled";
    } else if (runtime.status === "disabled") {
      runtime.status = "disconnected";
    }
    this.persist();
    this.emit("status", { serverId: id });
    this.emit("tools", { serverId: id });
  }

  private resolveEnv(server: MCPServerConfig): Record<string, string> {
    const conn = server.connection as StdioConnection;
    const env: Record<string, string> = { ...(conn.env ?? {}) };
    for (const key of conn.secretEnv ?? []) {
      const value = getSecret(envRef(server.id, key));
      if (typeof value === "string") env[key] = value;
    }
    return env;
  }

  private resolveHeaders(server: MCPServerConfig): Record<string, string> {
    const conn = server.connection as HttpConnection;
    const headers: Record<string, string> = { ...(conn.headers ?? {}) };
    for (const key of conn.secretHeaders ?? []) {
      const value = getSecret(headerRef(server.id, key));
      if (typeof value === "string") headers[key] = value;
    }
    const token = getSecret(authRef(server.id));
    if (token && conn.auth !== null) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  private clientOptions(server: MCPServerConfig): any {
    return {
      serverId: server.id,
      log: (level: string, message: string) => {
        const runtime = this.runtime(server.id);
        runtime.logs.push(level, message);
        this.emit("log", { serverId: server.id, level, message });
      },
      env: this.resolveEnv(server),
      startupTimeoutMs: server.startupTimeoutMs ?? 30000,
      onExit: (info: { code: number | null; signal: string | null; expected: boolean }) => this.handleExit(server.id, info),
      onToolsChanged: () => {
        void this.refreshTools(server.id).catch(() => undefined);
      },
    };
  }

  private handleExit(serverId: string, info: { code: number | null; signal: string | null; expected: boolean }): void {
    const runtime = this.runtime(serverId);
    runtime.client = null;
    runtime.pid = null;
    runtime.tools = [];
    if (info.expected) {
      if (runtime.status !== "disabled") runtime.status = "disconnected";
      this.emit("status", { serverId });
      this.emit("tools", { serverId });
      return;
    }
    runtime.status = "error";
    runtime.lastError = `process exited unexpectedly (code=${info.code ?? "null"})`;
    this.emit("status", { serverId });
    this.emit("tools", { serverId });
    void this.maybeReconnect(serverId);
  }

  private async maybeReconnect(serverId: string): Promise<void> {
    const server = this.find(serverId);
    const runtime = this.runtime(serverId);
    if (!server || !server.enabled) return;
    if ((server.restartPolicy ?? "on_failure") !== "on_failure") return;
    if (runtime.attempts >= 3) {
      runtime.logs.push("error", "restart policy: giving up after 3 attempts");
      return;
    }
    runtime.attempts += 1;
    runtime.status = "reconnecting";
    this.emit("status", { serverId });
    const delay = 1500 * runtime.attempts;
    runtime.logs.push("info", `restarting in ${delay}ms (attempt ${runtime.attempts}/3)`);
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = null;
      void this.connect(serverId).catch(() => undefined);
    }, delay);
  }

  async connect(id: string): Promise<ServerRuntimeView> {
    const server = this.find(id);
    if (!server) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
    if (!server.enabled) throw new ApiError("MCP_SERVER_DISABLED", "Enable the server before connecting", 409, { serverId: id });
    const runtime = this.runtime(id);
    // "reconnecting" must stay connectable: the restart policy schedules a connect while
    // the runtime is in that state, and blocking it makes auto-restart a no-op.
    if (runtime.status === "starting" || runtime.status === "connected") {
      if (runtime.status === "connected") return this.view(id);
      throw new ApiError("MCP_BUSY", `Server ${id} is already ${runtime.status}`, 409, { serverId: id });
    }
    if (runtime.client) {
      try {
        await runtime.client.close();
      } catch {
        // ignore
      }
      runtime.client = null;
    }

    runtime.status = "starting";
    runtime.lastError = null;
    runtime.logs.push("info", "connecting…");
    this.emit("status", { serverId: id });

    const options = this.clientOptions(server);
    const client: MCPClient =
      server.transport === "stdio"
        ? new StdioClient(server, options)
        : new StreamableHttpClient(server, options, this.resolveHeaders(server));
    runtime.client = client;

    try {
      await client.connect();
      const tools = await client.listTools();
      runtime.tools = tools;
      runtime.pid = client.pid;
      runtime.status = "connected";
      runtime.lastConnected = nowIso();
      runtime.connectedAt = nowIso();
      runtime.attempts = 0;
      runtime.lastError = null;
      runtime.logs.push("info", `connected — ${tools.length} tool${tools.length === 1 ? "" : "s"} discovered`);
      this.emit("status", { serverId: id });
      this.emit("tools", { serverId: id });
      return this.view(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.status = "error";
      runtime.lastError = message;
      runtime.logs.push("error", message);
      runtime.client = null;
      try {
        await client.close();
      } catch {
        // ignore
      }
      this.emit("status", { serverId: id });
      // A failed connect (bad executable, handshake timeout) is as recoverable as a crash.
      if (server.enabled && (server.restartPolicy ?? "on_failure") === "on_failure") {
        void this.maybeReconnect(id);
      }
      const code = message.split(":")[0];
      throw new ApiError(
        /^MCP_[A-Z_]+$/.test(code) ? code : "MCP_INITIALIZATION_FAILED",
        message,
        502,
        { serverId: id },
      );
    }
  }

  async disconnect(id: string): Promise<ServerRuntimeView> {
    const runtime = this.runtime(id);
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
    const client = runtime.client;
    if (!client) {
      runtime.status = this.find(id)?.enabled ? "disconnected" : "disabled";
      runtime.tools = [];
      this.emit("status", { serverId: id });
      this.emit("tools", { serverId: id });
      return this.view(id);
    }
    runtime.status = "stopping";
    this.emit("status", { serverId: id });
    try {
      await client.close();
    } catch (error) {
      runtime.logs.push("warn", `close failed: ${(error as Error).message}`);
    }
    runtime.client = null;
    runtime.pid = null;
    runtime.tools = [];
    runtime.status = this.find(id)?.enabled ? "disconnected" : "disabled";
    runtime.logs.push("info", "disconnected");
    this.emit("status", { serverId: id });
    this.emit("tools", { serverId: id });
    return this.view(id);
  }

  async restart(id: string): Promise<ServerRuntimeView> {
    await this.disconnect(id);
    const runtime = this.runtime(id);
    runtime.attempts = 0;
    return this.connect(id);
  }

  async refreshTools(id: string): Promise<ToolView[]> {
    const runtime = this.runtime(id);
    if (!runtime.client || runtime.status !== "connected") {
      throw new ApiError("MCP_SERVER_NOT_CONNECTED", "Connect the server before refreshing tools", 409, { serverId: id });
    }
    const tools = await runtime.client.listTools();
    runtime.tools = tools;
    runtime.logs.push("info", `tool discovery refreshed — ${tools.length} tools`);
    this.emit("tools", { serverId: id });
    return this.view(id).tools;
  }

  private toolSettings(server: MCPServerConfig, toolName: string): { enabled: boolean; permission: PermissionMode } {
    const entry = server.tools?.[toolName];
    return { enabled: entry?.enabled !== false, permission: entry?.permission ?? "allow" };
  }

  exposedName(serverId: string, toolName: string): string {
    return `${serverId}__${sanitizeToolName(toolName)}`;
  }

  catalog(): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const server of this.servers) {
      const runtime = this.runtime(server.id);
      for (const tool of runtime.tools) {
        const settings = this.toolSettings(server, tool.name);
        out.push({
          serverId: server.id,
          serverName: server.name,
          visibility: server.visibility,
          toolName: tool.name,
          exposedName: this.exposedName(server.id, tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
          enabled: settings.enabled,
          permission: settings.permission,
        });
      }
    }
    return out;
  }

  injectable(): CatalogEntry[] {
    return this.catalog().filter((entry) => {
      if (!entry.enabled) return false;
      if (entry.permission === "deny") return false;
      const server = this.find(entry.serverId);
      if (!server?.enabled) return false;
      return this.runtime(entry.serverId).status === "connected";
    });
  }

  patchTool(exposedName: string, patch: { enabled?: boolean; permission?: PermissionMode }): CatalogEntry {
    const entry = this.catalog().find((item) => item.exposedName === exposedName);
    if (!entry) throw new ApiError("MCP_TOOL_NOT_FOUND", `Unknown tool: ${exposedName}`, 404, { tool: exposedName });
    const server = this.find(entry.serverId);
    if (!server) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${entry.serverId}`, 404);
    server.tools = server.tools ?? {};
    const current = this.toolSettings(server, entry.toolName);
    server.tools[entry.toolName] = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      permission: patch.permission ?? current.permission,
    };
    server.updatedAt = nowIso();
    this.persist();
    this.emit("tools", { serverId: server.id });
    return this.catalog().find((item) => item.exposedName === exposedName) as CatalogEntry;
  }

  view(id: string): ServerRuntimeView {
    const server = this.find(id);
    if (!server) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
    const runtime = this.runtime(id);
    const tools: ToolView[] = runtime.tools.map((tool) => {
      const settings = this.toolSettings(server, tool.name);
      return {
        name: tool.name,
        exposedName: this.exposedName(server.id, tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
        enabled: settings.enabled,
        permission: settings.permission,
      };
    });
    return {
      status: runtime.status,
      pid: runtime.pid,
      resolvedCommand: runtime.client?.resolvedCommand ?? null,
      lastConnected: runtime.lastConnected,
      lastError: runtime.lastError,
      connectedAt: runtime.connectedAt,
      toolCount: tools.length,
      enabledToolCount: tools.filter((tool) => tool.enabled && tool.permission !== "deny").length,
      tools,
      calls: runtime.calls,
    };
  }

  logs(id: string): LogEntry[] {
    if (!this.find(id)) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
    return this.runtime(id).logs.list();
  }

  clearLogs(id: string): void {
    if (!this.find(id)) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
    this.runtime(id).logs.clear();
  }

  /**
   * Look up a direct call by exposed name, reconnecting the owning server when an idle
   * stop removed its tools from the catalog. Returns `null` when the name genuinely does
   * not exist, so callers keep reporting the ordinary MCP_TOOL_NOT_FOUND.
   */
  async resolveDirectTool(exposedName: string): Promise<{ entry: CatalogEntry; reconnected: boolean } | null> {
    const found = this.catalog().find((item) => item.exposedName === exposedName);
    if (found) return { entry: found, reconnected: false };

    // The catalog only lists tools of connected servers, so an idle stop looks exactly
    // like a typo. Resolve the owner from the `serverId__toolName` prefix instead.
    const owner = this.servers
      .filter((server) => exposedName.startsWith(`${server.id}__`))
      .sort((a, b) => b.id.length - a.id.length)[0];
    if (!owner || !owner.enabled) return null;
    const status = this.runtime(owner.id).status;
    // Still connected means the tool really is gone; starting means a connect is already
    // in flight and this call must not race it.
    if (status === "connected" || status === "starting") return null;

    const runtime = this.runtime(owner.id);
    runtime.logs.push("info", `direct call to ${exposedName} — reconnecting idle-stopped server`);
    this.emit("log", { serverId: owner.id, level: "info", message: "reconnecting for a direct tool call" });
    await this.connect(owner.id);

    const recovered = this.catalog().find((item) => item.exposedName === exposedName);
    return recovered ? { entry: recovered, reconnected: true } : null;
  }

  async callTool(serverId: string, toolName: string, args: unknown, timeoutMs: number): Promise<ToolResult> {
    const runtime = this.runtime(serverId);
    if (!runtime.client || runtime.status !== "connected") {
      throw new Error(`MCP_SERVER_NOT_CONNECTED: ${serverId} is not connected`);
    }
    runtime.calls += 1;
    return runtime.client.callTool(toolName, args, timeoutMs);
  }

  /**
   * Calls a tool, reconnecting once when the server idle-stopped between discovery and the call
   * itself. `alreadyReconnected` is set by callers that just reconnected the server through
   * `resolveDirectTool`, so one call never respawns a dead server twice; the flag comes back true
   * when a reconnect was involved at all.
   */
  async callToolWithReconnect(
    serverId: string,
    toolName: string,
    args: unknown,
    timeoutMs: number,
    alreadyReconnected = false,
  ): Promise<{ result: ToolResult; reconnected: boolean }> {
    try {
      return { result: await this.callTool(serverId, toolName, args, timeoutMs), reconnected: alreadyReconnected };
    } catch (error) {
      if (alreadyReconnected || !isNotConnected(error)) throw error;
      await this.connect(serverId);
      return { result: await this.callTool(serverId, toolName, args, timeoutMs), reconnected: true };
    }
  }

  async shutdown(): Promise<void> {
    for (const server of this.servers) {
      const runtime = this.runtimes.get(server.id);
      if (runtime?.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    }
    await Promise.all(
      this.servers.map(async (server) => {
        const runtime = this.runtimes.get(server.id);
        if (runtime?.client) {
          try {
            await runtime.client.close();
          } catch {
            // ignore
          }
        }
      }),
    );
  }
}
