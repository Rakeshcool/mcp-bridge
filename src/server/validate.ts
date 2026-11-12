import type { MCPServerConfig, PermissionMode, StdioConnection, HttpConnection } from "./types.ts";

export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const PERMISSIONS = new Set<PermissionMode>(["allow", "ask", "deny"]);
const TRANSPORTS = new Set(["stdio", "streamable_http"]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clampTimeout(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.round(num), 1000), 900000);
}

function clampIdle(value: unknown, fallback: number): number {
  if (value === 0 || value === "0") return 0;
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(Math.max(Math.round(num), 1000), 900000);
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) continue;
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

export function slugId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function validateToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const source = schema as Record<string, unknown>;
  if (source.type !== "object") {
    return { type: "object", properties: {} };
  }
  return source;
}

export function validateServerInput(raw: unknown, existingIds: string[], isNew: boolean): MCPServerConfig {
  if (!raw || typeof raw !== "object") {
    throw new ApiError("MCP_INVALID_CONFIG", "Server configuration must be an object");
  }
  const body = raw as Record<string, unknown>;
  const transport = asString(body.transport) ?? "stdio";
  if (!TRANSPORTS.has(transport)) {
    throw new ApiError("MCP_INVALID_CONFIG", `Unsupported transport: ${transport}`, 400, {
      allowed: [...TRANSPORTS],
    });
  }

  const name = (asString(body.name) ?? "").trim();
  if (!name) throw new ApiError("MCP_INVALID_CONFIG", "Name is required");
  if (name.length > 100) throw new ApiError("MCP_INVALID_CONFIG", "Name must be 100 characters or fewer");

  const id = slugId(asString(body.id) || name || "server");
  if (!ID_PATTERN.test(id)) {
    throw new ApiError("MCP_INVALID_CONFIG", "Server id must be lowercase letters, digits, dash or underscore");
  }
  if (isNew && existingIds.includes(id)) {
    throw new ApiError("MCP_DUPLICATE_SERVER", `A server with id "${id}" already exists`, 409, { id });
  }

  const visibility = asString(body.visibility) === "hidden_until_mentioned" ? "hidden_until_mentioned" : "normal";
  const restartPolicy = asString(body.restartPolicy) === "never" ? "never" : "on_failure";

  let connection: StdioConnection | HttpConnection;
  if (transport === "stdio") {
    const input = (body.connection ?? {}) as Record<string, unknown>;
    const command = (asString(input.command) ?? "").trim();
    if (!command) throw new ApiError("MCP_INVALID_CONFIG", "Command is required for a local stdio server");
    const rawArgs = input.args;
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
      throw new ApiError("MCP_INVALID_CONFIG", "Arguments must be an array of strings");
    }
    const args = Array.isArray(rawArgs) ? rawArgs.map((arg) => String(arg)) : [];
    const stdio: StdioConnection = { command, args };
    const cwd = asString(input.cwd);
    if (cwd && cwd.trim()) stdio.cwd = cwd.trim();
    const env = stringRecord(input.env);
    if (Object.keys(env).length) stdio.env = env;
    const secretEnv = Array.isArray(input.secretEnv) ? input.secretEnv.map((key) => String(key)) : [];
    stdio.secretEnv = secretEnv.filter((key) => key.trim().length > 0);
    connection = stdio;
  } else {
    const input = (body.connection ?? {}) as Record<string, unknown>;
    const url = (asString(input.url) ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError("MCP_INVALID_CONFIG", "Server URL must be a valid absolute URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ApiError("MCP_INVALID_CONFIG", "Server URL must use http or https");
    }
    const http: HttpConnection = { url: parsed.toString(), verifyTls: input.verifyTls !== false };
    const headers = stringRecord(input.headers);
    if (Object.keys(headers).length) http.headers = headers;
    const secretHeaders = Array.isArray(input.secretHeaders)
      ? input.secretHeaders.map((key) => String(key)).filter((key) => key.trim().length > 0)
      : [];
    http.secretHeaders = secretHeaders;
    http.auth = asString(input.authType) === "none" ? null : { type: "bearer", secretRef: `${id}::auth::token` };
    connection = http;
  }

  const tools: Record<string, { enabled: boolean; permission: PermissionMode }> = {};
  if (body.tools && typeof body.tools === "object" && !Array.isArray(body.tools)) {
    for (const [toolName, value] of Object.entries(body.tools as Record<string, unknown>)) {
      const entry = (value ?? {}) as Record<string, unknown>;
      const permission = asString(entry.permission) as PermissionMode | undefined;
      tools[toolName] = {
        enabled: entry.enabled !== false,
        permission: permission && PERMISSIONS.has(permission) ? permission : "allow",
      };
    }
  }

  const now = new Date().toISOString();
  return {
    id,
    name,
    description: (asString(body.description) ?? "").trim(),
    enabled: body.enabled !== false,
    visibility,
    transport: transport as MCPServerConfig["transport"],
    connection,
    startupTimeoutMs: clampTimeout(body.startupTimeoutMs, 30000),
    toolTimeoutMs: clampTimeout(body.toolTimeoutMs, 60000),
    idleTimeoutMs: clampIdle(body.idleTimeoutMs, 300000),
    restartPolicy,
    tools,
    createdAt: asString(body.createdAt) || now,
    updatedAt: now,
  };
}
