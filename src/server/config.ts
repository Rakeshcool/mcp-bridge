import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "./paths.ts";
import type {
  BridgeSettings,
  ConnectionsSettings,
  DiscoverySettings,
  MCPConfigFile,
  MCPServerConfig,
} from "./types.ts";

const SERVERS_FILE = path.join(DATA_DIR, "servers.json");
const BRIDGE_FILE = path.join(DATA_DIR, "bridge.json");

function atomicWrite(file: string, data: unknown): void {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * First run starts with no servers: this bridge is not tied to any product.
 * Add one from the panel, `POST /api/servers`, or by copying entries out of
 * `servers.example.json`.
 */
function seedConfig(): MCPConfigFile {
  return { version: 1, servers: [] };
}

/** Drops entries a hand-edited config could not run, instead of crashing the panel. */
function normalizeServer(entry: unknown): MCPServerConfig | null {
  if (!entry || typeof entry !== "object") return null;
  const server = entry as Record<string, any>;
  if (typeof server.id !== "string" || !server.id) return null;
  if (server.transport !== "stdio" && server.transport !== "streamable_http" && server.transport !== "connector") {
    return null;
  }
  const connection = server.connection;
  if (!connection || typeof connection !== "object") return null;
  if (server.transport === "stdio") {
    if (typeof connection.command !== "string" || !connection.command) return null;
    connection.args = Array.isArray(connection.args) ? connection.args.map((arg: unknown) => String(arg)) : [];
  } else if (server.transport === "streamable_http") {
    if (typeof connection.url !== "string" || !connection.url) return null;
  }
  return {
    ...server,
    enabled: server.enabled !== false,
    visibility: server.visibility === "hidden_until_mentioned" ? "hidden_until_mentioned" : "normal",
    tools: server.tools && typeof server.tools === "object" ? server.tools : {},
  } as MCPServerConfig;
}

export function loadConfig(): MCPConfigFile {
  try {
    const raw = JSON.parse(fs.readFileSync(SERVERS_FILE, "utf8"));
    const entries = Array.isArray(raw?.servers) ? raw.servers : [];
    const servers = entries.map(normalizeServer).filter((entry: MCPServerConfig | null): entry is MCPServerConfig => entry !== null);
    return { version: 1, servers };
  } catch {
    const seeded = seedConfig();
    try {
      atomicWrite(SERVERS_FILE, seeded);
    } catch {
      // read-only disk: still serve the in-memory seed
    }
    return seeded;
  }
}

export function saveConfig(config: MCPConfigFile): void {
  atomicWrite(SERVERS_FILE, { version: 1, servers: config.servers });
}

export function defaultDiscoverySettings(): DiscoverySettings {
  return {
    enabled: true,
    watchRegistrationDirectory: true,
    autoRegister: false,
    requireApproval: true,
  };
}

export function defaultConnectionsSettings(): ConnectionsSettings {
  return {
    // Off by default: the bridge has always connected servers lazily, on first use.
    autoConnect: false,
    autoReconnect: true,
    maxRetries: 5,
  };
}

export function defaultBridgeSettings(): BridgeSettings {
  return {
    baseUrl: process.env.LLAMA_BASE || "http://127.0.0.1:8080",
    model: "",
    maxRounds: 5,
    toolTimeoutMs: 60000,
    requestTimeoutMs: 600000,
    discovery: defaultDiscoverySettings(),
    connections: defaultConnectionsSettings(),
  };
}

/** Merges whichever discovery fields a hand-edited bridge.json actually contains. */
export function mergeDiscoverySettings(raw: unknown, base = defaultDiscoverySettings()): DiscoverySettings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : base.directory;
  return {
    enabled: bool(input.enabled, base.enabled),
    watchRegistrationDirectory: bool(input.watchRegistrationDirectory, base.watchRegistrationDirectory),
    autoRegister: bool(input.autoRegister, base.autoRegister),
    requireApproval: bool(input.requireApproval, base.requireApproval),
    ...(directory ? { directory } : {}),
  };
}

export function mergeConnectionsSettings(raw: unknown, base = defaultConnectionsSettings()): ConnectionsSettings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const num = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.round(parsed), min), max);
  };
  return {
    autoConnect: bool(input.autoConnect, base.autoConnect),
    autoReconnect: bool(input.autoReconnect, base.autoReconnect),
    maxRetries: num(input.maxRetries, base.maxRetries, 0, 20),
  };
}

export function loadBridgeSettings(): BridgeSettings {
  const defaults = defaultBridgeSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8")) as Record<string, unknown>;
    const merged: BridgeSettings = { ...defaults };
    for (const key of ["baseUrl", "model", "maxRounds", "toolTimeoutMs", "requestTimeoutMs"] as const) {
      const value = raw?.[key];
      if (typeof value === typeof defaults[key]) (merged as unknown as Record<string, unknown>)[key] = value;
    }
    merged.discovery = mergeDiscoverySettings(raw?.discovery, defaults.discovery);
    merged.connections = mergeConnectionsSettings(raw?.connections, defaults.connections);
    return merged;
  } catch {
    return defaults;
  }
}

export function saveBridgeSettings(settings: BridgeSettings): void {
  atomicWrite(BRIDGE_FILE, settings);
}
