export type PermissionMode = "allow" | "ask" | "deny";
export type ServerStatus =
  | "disabled"
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

export interface ServerView {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  visibility: "normal" | "hidden_until_mentioned";
  transport: "stdio" | "streamable_http";
  connection: Record<string, any>;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  restartPolicy: "never" | "on_failure";
  runtime: RuntimeView;
  logs: LogEntry[];
}

export interface BridgeSettings {
  baseUrl: string;
  model: string;
  maxRounds: number;
  toolTimeoutMs: number;
  requestTimeoutMs: number;
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

export interface AppState {
  servers: ServerView[];
  bridge: BridgeSettings;
  upstream: UpstreamStatus;
  approvals: ApprovalRequest[];
  activity: ActivityRecord[];
  catalog: unknown[];
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

export function transportLabel(transport: string): string {
  return transport === "stdio" ? "Local stdio" : "Remote HTTP";
}

export function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}
