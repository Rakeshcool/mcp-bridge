export type PermissionMode = "allow" | "ask" | "deny";
export type ServerStatus =
  | "disabled"
  | "discovered"
  | "pending_approval"
  | "disconnected"
  | "starting"
  | "connected"
  | "reconnecting"
  | "stopping"
  | "error";

export interface ToolView {
  name: string;
  exposedName: string;
  description: string;
  inputSchema: unknown;
  enabled: boolean;
  permission: PermissionMode;
}

export interface RuntimeView {
  status: ServerStatus;
  pid: number | null;
  lastConnected: string | null;
  lastError: string | null;
  connectedAt: string | null;
  toolCount: number;
  enabledToolCount: number;
  tools: ToolView[];
  calls: number;
}

export interface LogEntry {
  ts: string;
  level: string;
  message: string;
}

export interface ServerApplication {
  name: string;
  version?: string;
  extensionType?: string;
}

export interface ServerView {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  visibility: "normal" | "hidden_until_mentioned";
  transport: "stdio" | "streamable_http" | "connector";
  connection: Record<string, any>;
  source: "manual" | "manifest" | "connector";
  approved: boolean;
  application: ServerApplication | null;
  capabilities: string[];
  manifestPath: string | null;
  manifestHash: string | null;
  manifestMissing: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  restartPolicy: "never" | "on_failure";
  runtime: RuntimeView;
  logs: LogEntry[];
}

export interface DiscoverySettings {
  enabled: boolean;
  watchRegistrationDirectory: boolean;
  autoRegister: boolean;
  requireApproval: boolean;
  directory?: string;
}

export interface ConnectionsSettings {
  autoConnect: boolean;
  autoReconnect: boolean;
  maxRetries: number;
}

export interface BridgeSettings {
  baseUrl: string;
  model: string;
  maxRounds: number;
  toolTimeoutMs: number;
  requestTimeoutMs: number;
  discovery?: DiscoverySettings;
  connections?: ConnectionsSettings;
}

export type DiscoveryOutcome =
  | "registered"
  | "pending_approval"
  | "unchanged"
  | "updated"
  | "conflict"
  | "ignored"
  | "invalid";

export interface DiscoveryEntry {
  id: string;
  name?: string;
  manifestPath: string;
  outcome: DiscoveryOutcome;
  error?: string;
  hash?: string;
  application?: ServerApplication | null;
  capabilities?: string[];
}

export interface PendingRegistration {
  id: string;
  name: string;
  manifestPath: string | null;
  application: ServerApplication | null;
  capabilities: string[];
  hash: string | null;
}

export interface DiscoveryState {
  directory: string;
  directoryAvailable: boolean;
  enabled: boolean;
  watching: boolean;
  lastScanAt: string | null;
  entries: DiscoveryEntry[];
  pending: PendingRegistration[];
  ignored: Record<string, string>;
}

export interface UpstreamStatus {
  reachable: boolean;
  baseUrl: string;
  model: string;
  models: string[];
  error?: string;
}

export interface ToolImagePreview {
  mimeType: string;
  /** Ready to use as an <img src> and to save: base64 with its data: prefix. */
  dataUrl: string;
}

export interface ToolCallRecord {
  name: string;
  serverId: string;
  toolName: string;
  args: string;
  permission: string;
  status: "ok" | "error" | "denied" | "skipped";
  durationMs: number;
  result: string;
  images?: ToolImagePreview[];
}

export interface ActivityRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  model: string;
  stream: boolean;
  rounds: Array<{ index: number; finishReason: string; toolCalls: ToolCallRecord[]; assistantChars: number }>;
  injectedTools: number;
  finalChars: number;
  error: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ApprovalRequest {
  id: string;
  serverId: string;
  serverName: string;
  tool: string;
  exposedName: string;
  args: string;
  timeoutMs: number;
}

export interface ConnectorState {
  path: string;
  protocol: number;
  enabled: boolean;
  tokenRequired: boolean;
  connections: Array<{
    serverId: string;
    application: { name: string; version?: string; extensionType?: string } | null;
    address: string | null;
    connectedAt: string;
    tools: number;
  }>;
  lastError: { at: string; message: string } | null;
}

export interface AppState {
  servers: ServerView[];
  bridge: BridgeSettings;
  upstream: UpstreamStatus;
  approvals: ApprovalRequest[];
  activity: ActivityRecord[];
  catalog: unknown[];
  discovery: DiscoveryState | null;
  /** Inbound WebSocket applications (the After Effects CEP panel), from GET /api/state. */
  connector: ConnectorState | null;
  /** Where other MCP clients connect, as published by GET /api/state. */
  mcp: { path: string; protocolVersion: string; transport: string; sse: boolean };
  platform: string;
}

interface CallOptions {
  method?: string;
  body?: unknown;
}

export async function call<T = any>(path: string, options: CallOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(data?.error?.message ?? data?.raw ?? `HTTP ${response.status}`);
  }
  return data as T;
}

export function getState(): Promise<AppState> {
  return call<AppState>("/api/state");
}

export function statusLabel(status: ServerStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "discovered":
      return "Discovered";
    case "pending_approval":
      return "Approval required";
    case "starting":
      return "Starting";
    case "reconnecting":
      return "Reconnecting";
    case "stopping":
      return "Stopping";
    case "error":
      return "Error";
    case "disabled":
      return "Disabled";
    default:
      return "Disconnected";
  }
}

export function statusClass(status: ServerStatus): string {
  switch (status) {
    case "connected":
      return "text-ok";
    case "pending_approval":
      return "text-warn";
    case "discovered":
      return "text-accent";
    case "starting":
    case "reconnecting":
    case "stopping":
      return "text-warn";
    case "error":
      return "text-bad";
    default:
      return "text-dim";
  }
}

export function statusDot(status: ServerStatus): string {
  switch (status) {
    case "connected":
      return "bg-ok";
    case "pending_approval":
      return "bg-warn";
    case "discovered":
      return "bg-accent";
    case "starting":
    case "reconnecting":
    case "stopping":
      return "bg-warn";
    case "error":
      return "bg-bad";
    default:
      return "bg-dim";
  }
}

/** Where a server is reached, for display: a command, the connector socket, or a URL. */
export function transportEndpoint(server: Pick<ServerView, "transport" | "connection">): string {
  if (server.transport === "connector") {
    const host = typeof location !== "undefined" ? location.host : "127.0.0.1:7800";
    return `ws://${host}${server.connection.endpoint ?? "/ws/connector"}`;
  }
  if (server.transport === "stdio") return String(server.connection.command ?? "");
  return String(server.connection.url ?? "");
}

export function transportLabel(transport: string): string {
  if (transport === "stdio") return "Local stdio";
  if (transport === "connector") return "Inbound connector";
  return "Remote HTTP";
}

export function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}
