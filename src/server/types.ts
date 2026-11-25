export type MCPTransport = "stdio" | "streamable_http" | "connector";

export type MCPStatus =
  | "disabled"
  | "discovered"
  | "pending_approval"
  | "disconnected"
  | "starting"
  | "connected"
  | "reconnecting"
  | "stopping"
  | "error";

export type ServerSource = "manual" | "manifest" | "connector";

/** Metadata an application publishes about itself in its registration manifest. */
export interface ServerApplication {
  name: string;
  version?: string;
  extensionType?: string;
}

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

/**
 * Inbound connector: the application dials the bridge over a WebSocket, so there is nothing to
 * launch and no URL to poll. Only the endpoint is recorded, for display and diagnostics.
 */
export interface ConnectorConnection {
  endpoint?: string;
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
  connection: StdioConnection | HttpConnection | ConnectorConnection;
  /** `manual` for hand-added servers; `manifest` for discovered registrations. */
  source?: ServerSource;
  /** False until the user approves a discovered manifest (approval is bound to `manifestHash`). */
  approved?: boolean;
  application?: ServerApplication;
  capabilities?: string[];
  manifestPath?: string;
  /** SHA-256 of the execution-relevant fields; a change requires re-approval. */
  manifestHash?: string;
  /** The manifest file disappeared; the record is kept so approval is not silently lost. */
  manifestMissing?: boolean;
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
  /** Optional metadata a server publishes; /mcp passes it through to its own clients. */
  title?: string;
  outputSchema?: unknown;
  annotations?: unknown;
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
  /** Machine-readable result a tool returned next to its text; /mcp passes it through. */
  structuredContent?: Record<string, unknown>;
}

export interface ServerRuntimeView {
  status: MCPStatus;
  pid: number | null;
  /** Absolute executable launched for a stdio server, after PATH resolution. */
  resolvedCommand?: string | null;
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

export interface DiscoverySettings {
  enabled: boolean;
  watchRegistrationDirectory: boolean;
  /** Register manifests without asking. Approval still gates connecting, unless requireApproval is off. */
  autoRegister: boolean;
  requireApproval: boolean;
  /** Explicit registration directory; empty means the per-platform default. */
  directory?: string;
}

export interface ConnectionsSettings {
  /** Connect approved servers on bridge startup. */
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
