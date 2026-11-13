export type MCPTransport = "stdio" | "streamable_http";

export type MCPStatus =
  | "disabled"
  | "disconnected"
  | "starting"
  | "connected"
  | "reconnecting"
  | "stopping"
  | "error";

export type PermissionMode = "allow" | "ask" | "deny";

export type Visibility = "normal" | "hidden_until_mentioned";

export interface StdioConnection {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  secretEnv?: string[];
}

export interface HttpConnection {
  url: string;
  headers?: Record<string, string>;
  secretHeaders?: string[];
  auth?: { type: "bearer"; secretRef?: string } | null;
  verifyTls?: boolean;
}

export interface ToolPermission {
  enabled: boolean;
  permission: PermissionMode;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  visibility: Visibility;
  transport: MCPTransport;
  connection: StdioConnection | HttpConnection;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  idleTimeoutMs?: number;
  restartPolicy?: "never" | "on_failure";
  tools?: Record<string, ToolPermission>;
  createdAt?: string;
  updatedAt?: string;
}

export interface MCPConfigFile {
  version: 1;
  servers: MCPServerConfig[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ToolImage {
  mimeType: string;
  /** base64, no data-URL prefix */
  data: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  /** Vision-capable tools (screenshots, scene captures) return image blocks. */
  images?: ToolImage[];
}

export interface ServerRuntimeView {
  status: MCPStatus;
  pid: number | null;
  lastConnected: string | null;
  lastError: string | null;
  connectedAt: string | null;
  toolCount: number;
  enabledToolCount: number;
  tools: ToolView[];
  calls: number;
}

export interface ToolView {
  name: string;
  exposedName: string;
  description: string;
  inputSchema: unknown;
  enabled: boolean;
  permission: PermissionMode;
}

export interface BridgeSettings {
  baseUrl: string;
  model: string;
  maxRounds: number;
  toolTimeoutMs: number;
  requestTimeoutMs: number;
}
