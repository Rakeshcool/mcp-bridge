import type { EventEmitter } from "node:events";
import { LogBuffer } from "./logs.ts";
import type { LogEntry } from "./logs.ts";
import { StdioClient } from "./mcp/stdio.ts";
import { StreamableHttpClient } from "./mcp/streamable.ts";
import type { MCPClient } from "./mcp/client.ts";
import { authRef, envRef, getSecret, headerRef } from "./secrets.ts";
import { ApiError } from "./validate.ts";
import { defaultConnectionsSettings } from "./config.ts";
import type { ConnectorRegistration } from "./mcp/connector.ts";
import type {
  ConnectionsSettings,
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
import type { DiscoveryOutcome, RegistrationManifest } from "./discovery.ts";

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
  /** Carried through from the server so /mcp clients see the same tool contract. */
  title?: string;
  outputSchema?: unknown;
  annotations?: unknown;
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

/** 1s, 2s, 4s … capped at 30s, with jitter so two crashed servers do not retry in lockstep. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30000, 1000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.round(random() * 250);
}

export class Registry {
  servers: MCPServerConfig[];
  private events: EventEmitter;
  private runtimes = new Map<string, Runtime>();
  private connecting = new Map<string, Promise<ServerRuntimeView>>();
  private persist: () => void;
  private getConnections: () => ConnectionsSettings;
  private getConnectorSession: (id: string) => MCPClient | null;

  constructor(
    servers: MCPServerConfig[],
    events: EventEmitter,
    persist: () => void,
    getConnections?: () => ConnectionsSettings,
    /** Live inbound connector sessions (panels), keyed by server id. Absent in most tests. */
    getConnectorSession?: (id: string) => MCPClient | null,
  ) {
    this.servers = servers;
    this.events = events;
    this.persist = persist;
    this.getConnections = getConnections ?? defaultConnectionsSettings;
    this.getConnectorSession = getConnectorSession ?? (() => null);
    for (const server of servers) this.runtimes.set(server.id, this.blankRuntime(server));
  }

  /**
   * Anything is approved unless it was recorded as unapproved: hand-added servers carry no flag,
   * discovered manifests and inbound connector applications start with `approved: false`.
   */
  isApproved(server: MCPServerConfig): boolean {
    return server.approved !== false;
  }

  /** Status a server returns to when it is not running. */
  private idleStatus(server: MCPServerConfig | undefined): MCPStatus {
    if (!server) return "disconnected";
    if (!this.isApproved(server)) return "pending_approval";
    if (!server.enabled) return "disabled";
    if (server.source === "manifest" && !this.runtime(server.id).lastConnected) return "discovered";
    return "disconnected";
  }

  private blankRuntime(server: MCPServerConfig): Runtime {
    return {
      status: this.idleStatus(server),
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
    } else {
      runtime.status = this.idleStatus(server);
    }
    this.persist();
    this.emit("status", { serverId: id });
    this.emit("tools", { serverId: id });
  }

  /**
   * Records the user's decision about a discovered server. Rejecting disables the record
   * but keeps it, so the manifest does not reappear as "new" on every scan.
   */
  setApproval(id: string, approved: boolean): void {
    const server = this.find(id);
    if (!server) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
    server.approved = approved;
    server.enabled = approved ? true : false;
    server.updatedAt = nowIso();
    const runtime = this.runtime(id);
    runtime.attempts = 0;
    if (!approved) {
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
      if (runtime.client) void this.disconnect(id).catch(() => undefined);
      else runtime.status = "disabled";
    } else {
      runtime.status = runtime.client ? runtime.status : this.idleStatus(server);
    }
    runtime.logs.push("info", approved ? "approved by the user" : "rejected by the user");
    this.persist();
    this.emit("status", { serverId: id });
    this.emit("tools", { serverId: id });
  }

  /**
   * Records an application that dialled in over the connector transport. Unlike a manifest there is
   * nothing to launch, so execution identity is the application itself; approval still gates it.
   * Metadata is refreshed in place without touching the user's approval.
   */
  registerConnector(registration: ConnectorRegistration, approvedByDefault: boolean): boolean {
    const identity = registration.server;
    const existing = this.find(identity.id);
    if (existing) {
      let changed = false;
      if (existing.name !== identity.name) {
        existing.name = identity.name;
        changed = true;
      }
      if ((existing.description ?? "") !== (identity.description ?? "")) {
        existing.description = identity.description;
        changed = true;
      }
      const application = registration.application ?? null;
      if (JSON.stringify(existing.application ?? null) !== JSON.stringify(application)) {
        existing.application = registration.application;
        changed = true;
      }
      if (JSON.stringify(existing.capabilities ?? []) !== JSON.stringify(registration.capabilities)) {
        existing.capabilities = registration.capabilities;
        changed = true;
      }
      if (changed) {
        existing.updatedAt = nowIso();
        this.persist();
        this.emit("status", { serverId: existing.id });
      }
      return this.isApproved(existing);
    }

    const config: MCPServerConfig = {
      id: identity.id,
      name: identity.name,
      ...(identity.description ? { description: identity.description } : {}),
      enabled: true,
      visibility: "normal",
      transport: "connector",
      connection: { endpoint: "/ws/connector" },
      source: "connector",
      approved: approvedByDefault,
      ...(registration.application ? { application: registration.application } : {}),
      capabilities: registration.capabilities,
      tools: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.servers.push(config);
    this.runtimes.set(config.id, this.blankRuntime(config));
    this.runtime(config.id).logs.push(
      "info",
      `application registered through the connector${approvedByDefault ? "" : " — approval required"}`,
    );
    this.persist();
    this.emit("status", { serverId: config.id });
    this.emit("tools", { serverId: config.id });
    return approvedByDefault;
  }

  /**
   * The panel's socket attached or went away. Either way the runtime the socket leaves behind is
   * stale: a connector is never launched, so there is nothing to retry until it dials in again.
   */
  connectorReset(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.client = null;
    runtime.tools = [];
    runtime.pid = null;
    runtime.status = this.idleStatus(this.find(id));
    this.emit("status", { serverId: id });
    this.emit("tools", { serverId: id });
  }

  /** Copies a manifest's metadata onto an existing record; the execution fields differ per branch. */
  private applyManifestMetadata(existing: MCPServerConfig, incoming: MCPServerConfig, manifestPath: string): void {
    existing.name = incoming.name;
    existing.description = incoming.description;
    existing.application = incoming.application;
    existing.capabilities = incoming.capabilities ?? [];
    existing.manifestPath = manifestPath;
    existing.manifestMissing = false;
    existing.updatedAt = nowIso();
  }

  /**
   * Applies a validated registration manifest. Approval is bound to `manifestHash`: a
   * manifest whose executable/arguments/url changed is a different thing to run, so it
   * goes back to pending approval even if the same id was approved before.
   */
  async applyDiscovery(input: {
    manifest: RegistrationManifest;
    manifestPath: string;
    manifestHash: string;
    config: MCPServerConfig;
    approvedByDefault: boolean;
  }): Promise<DiscoveryOutcome> {
    const incoming = input.config;
    const existing = this.find(incoming.id);

    if (!existing) {
      const config: MCPServerConfig = { ...incoming, approved: input.approvedByDefault, enabled: true };
      this.servers.push(config);
      this.runtimes.set(config.id, this.blankRuntime(config));
      this.runtime(config.id).logs.push(
        "info",
        `discovered from ${input.manifestPath}${input.approvedByDefault ? " (auto-registered)" : " — approval required"}`,
      );
      this.persist();
      this.emit("status", { serverId: config.id });
      this.emit("tools", { serverId: config.id });
      return input.approvedByDefault ? "registered" : "pending_approval";
    }

    if (existing.source !== "manifest") return "conflict";

    // A rescan runs every 15 s; writing servers.json each time churns the file (and every
    // backup/sync tool watching it) for no change. Compare first, persist only when it differs.
    const metadataChanged =
      existing.name !== incoming.name ||
      (existing.description ?? "") !== (incoming.description ?? "") ||
      JSON.stringify(existing.application ?? null) !== JSON.stringify(incoming.application ?? null) ||
      JSON.stringify(existing.capabilities ?? []) !== JSON.stringify(incoming.capabilities ?? []) ||
      existing.manifestPath !== input.manifestPath ||
      existing.manifestMissing === true;

    if (existing.manifestHash === input.manifestHash) {
      if (!metadataChanged) return this.isApproved(existing) ? "unchanged" : "pending_approval";
      this.applyManifestMetadata(existing, incoming, input.manifestPath);
      this.persist();
      this.emit("status", { serverId: existing.id });
      this.emit("tools", { serverId: existing.id });
      return this.isApproved(existing) ? "unchanged" : "pending_approval";
    }

    this.applyManifestMetadata(existing, incoming, input.manifestPath);

    const wasConnected = this.runtime(existing.id).client !== null;
    if (wasConnected) {
      try {
        await this.disconnect(existing.id);
      } catch {
        // Recorded on the runtime either way.
      }
    }
    existing.transport = incoming.transport;
    existing.connection = incoming.connection;
    existing.manifestHash = input.manifestHash;
    existing.approved = input.approvedByDefault ? true : false;
    existing.enabled = true;

    const runtime = this.runtime(existing.id);
    runtime.attempts = 0;
    runtime.lastError = null;
    runtime.status = this.isApproved(existing) ? (runtime.lastConnected ? "disconnected" : "discovered") : "pending_approval";
    runtime.logs.push(
      "info",
      input.approvedByDefault
        ? "manifest changed — configuration replaced"
        : "manifest changed — approval required again",
    );
    this.persist();
    this.emit("status", { serverId: existing.id });
    this.emit("tools", { serverId: existing.id });
    return this.isApproved(existing) ? "updated" : "pending_approval";
  }

  /** The manifest file is gone; keep the record so an approval is not silently discarded. */
  markManifestMissing(id: string): void {
    const server = this.find(id);
    if (!server || server.manifestMissing) return;
    server.manifestMissing = true;
    server.updatedAt = nowIso();
    this.runtime(id).logs.push("warn", "registration manifest disappeared; keeping the approved configuration");
    this.persist();
    this.emit("status", { serverId: id });
  }

  /** A connector is never launched: the registry asks the hub for the panel's live socket. */
  private connectorSession(server: MCPServerConfig): MCPClient {
    const session = this.getConnectorSession(server.id);
    if (!session) {
      throw new Error(
        `MCP_CONNECTOR_OFFLINE: "${server.name}" is not connected. Open the application's panel and connect it to this bridge.`,
      );
    }
    return session;
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
    // A connector is dialled in by the application; waiting on a timer cannot bring it back.
    if (server.transport === "connector") return;
    if (!this.isApproved(server)) return;
    if (!this.getConnections().autoReconnect) return;
    if ((server.restartPolicy ?? "on_failure") !== "on_failure") return;
    const maxRetries = this.getConnections().maxRetries;
    if (maxRetries <= 0) return;
    if (runtime.attempts >= maxRetries) {
      runtime.logs.push("error", `restart policy: giving up after ${maxRetries} attempt${maxRetries === 1 ? "" : "s"}`);
      this.emit("status", { serverId });
      return;
    }
    runtime.attempts += 1;
    runtime.status = "reconnecting";
    this.emit("status", { serverId });
    const delay = reconnectDelay(runtime.attempts);
    runtime.logs.push("info", `restarting in ${delay}ms (attempt ${runtime.attempts}/${maxRetries})`);
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = null;
      void this.connect(serverId).catch(() => undefined);
    }, delay);
  }

  /**
   * Connects a server, joining an attempt that is already in flight instead of refusing it. Two
   * callers that both find the server idle-stopped therefore share one reconnect; without this the
   * second one failed with MCP_BUSY from a tool call, or saw the tool as missing from discovery.
   */
  connect(id: string): Promise<ServerRuntimeView> {
    const inFlight = this.connecting.get(id);
    if (inFlight) return inFlight;
    const attempt = this.doConnect(id).finally(() => {
      if (this.connecting.get(id) === attempt) this.connecting.delete(id);
    });
    this.connecting.set(id, attempt);
    return attempt;
  }

  private async doConnect(id: string): Promise<ServerRuntimeView> {
    const server = this.find(id);
    if (!server) throw new ApiError("MCP_SERVER_NOT_FOUND", `Unknown server: ${id}`, 404);
    if (!this.isApproved(server)) {
      throw new ApiError(
        "MCP_APPROVAL_REQUIRED",
        `"${server.name}" was discovered but not approved yet. Approve it in Connected Applications first.`,
        409,
        { serverId: id },
      );
    }
    if (!server.enabled) throw new ApiError("MCP_SERVER_DISABLED", "Enable the server before connecting", 409, { serverId: id });
    const runtime = this.runtime(id);
    // "reconnecting" must stay connectable: the restart policy schedules a connect while
    // the runtime is in that state, and blocking it makes auto-restart a no-op.
    if (runtime.status === "connected") return this.view(id);
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
    runtime.client = null;

    try {
      const client: MCPClient =
        server.transport === "connector"
          ? this.connectorSession(server)
          : server.transport === "stdio"
            ? new StdioClient(server, options)
            : new StreamableHttpClient(server, options, this.resolveHeaders(server));
      runtime.client = client;
      // A panel can announce a changed tool set at any time; reuse the same refresh path as stdio.
      client.onToolsChanged(() => {
        void this.refreshTools(server.id).catch(() => undefined);
      });
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
      const client = runtime.client;
      runtime.client = null;
      if (client) {
        try {
          await client.close();
        } catch {
          // ignore
        }
      }
      // A closed panel is not a broken server: report it as offline, and do not retry a
      // connection only the application itself can make.
      if (server.transport === "connector" && message.startsWith("MCP_CONNECTOR_OFFLINE")) {
        runtime.status = this.isApproved(server) ? "disconnected" : "pending_approval";
        this.emit("status", { serverId: id });
        throw new ApiError("MCP_CONNECTOR_OFFLINE", message, 409, { serverId: id });
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
    // An attempt already in flight belongs to the connection being closed: forget it here so a
    // `restart` connects again instead of joining the attempt this method just killed.
    this.connecting.delete(id);
    const runtime = this.runtime(id);
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
    const client = runtime.client;
    if (!client) {
      runtime.status = this.idleStatus(this.find(id));
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
    runtime.status = this.idleStatus(this.find(id));
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

  /**
   * `foo.bar` and `foo-bar` sanitize to the same name inside one server, which used to give
   * two catalog entries the same `exposedName` (and made `patchTool` edit whichever came
   * first). Suffixes are assigned deterministically by sorted tool name.
   */
  private nameMap(serverId: string, tools: ToolDef[]): Map<string, string> {
    const groups = new Map<string, string[]>();
    for (const tool of tools) {
      const base = this.exposedName(serverId, tool.name);
      const group = groups.get(base);
      if (group) group.push(tool.name);
      else groups.set(base, [tool.name]);
    }
    const out = new Map<string, string>();
    for (const [base, names] of groups) {
      if (names.length === 1) {
        out.set(names[0], base);
        continue;
      }
      [...names].sort().forEach((name, index) => out.set(name, index === 0 ? base : `${base}__${index + 1}`));
    }
    return out;
  }

  catalog(): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const server of this.servers) {
      const runtime = this.runtime(server.id);
      const names = this.nameMap(server.id, runtime.tools);
      for (const tool of runtime.tools) {
        const settings = this.toolSettings(server, tool.name);
        out.push({
          serverId: server.id,
          serverName: server.name,
          visibility: server.visibility,
          toolName: tool.name,
          exposedName: names.get(tool.name) ?? this.exposedName(server.id, tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
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
    const names = this.nameMap(server.id, runtime.tools);
    const tools: ToolView[] = runtime.tools.map((tool) => {
      const settings = this.toolSettings(server, tool.name);
      return {
        name: tool.name,
        exposedName: names.get(tool.name) ?? this.exposedName(server.id, tool.name),
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

  /** Appends a bridge-side line (an /mcp request, say) to one server's log, where its tab shows it. */
  appendLog(serverId: string, level: string, message: string): void {
    const runtime = this.runtimes.get(serverId);
    if (!runtime) return;
    runtime.logs.push(level, message);
    this.emit("log", { serverId, level, message });
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
    const runtime = this.runtime(owner.id);
    // Still connected means the tool really is gone. "starting" means another caller is already
    // reconnecting this server, and `connect` joins that attempt instead of racing it.
    if (runtime.status === "connected") return null;
    if (runtime.status !== "starting") {
      runtime.logs.push("info", `direct call to ${exposedName} — reconnecting idle-stopped server`);
      this.emit("log", { serverId: owner.id, level: "info", message: "reconnecting for a direct tool call" });
    }
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
   * itself. `alreadyReconnected` marks a caller that just reconnected through `resolveDirectTool`,
   * so one call never respawns a dead server twice. Returns whether a reconnect was involved.
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
