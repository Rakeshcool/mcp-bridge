import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "./paths.ts";
import type { BridgeSettings, MCPConfigFile, MCPServerConfig } from "./types.ts";

const SERVERS_FILE = path.join(DATA_DIR, "servers.json");
const BRIDGE_FILE = path.join(DATA_DIR, "bridge.json");

export const RESOLVE_MCP_PATH = "D:\\games\\Blackmagic Design\\DaVinci Resolve\\ResolveMCP.exe";

function atomicWrite(file: string, data: unknown): void {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function seedConfig(): MCPConfigFile {
  const now = new Date().toISOString();
  const resolve: MCPServerConfig = {
    id: "davinci-resolve",
    name: "DaVinci Resolve",
    description:
      "Blackmagic's official DaVinci Resolve MCP server. Automates Resolve's pages through its Python scripting API, manages LUTs and DCTLs, and reports Resolve's status.",
    enabled: true,
    visibility: "normal",
    transport: "stdio",
    connection: {
      command: RESOLVE_MCP_PATH,
      args: [],
      env: { BMD_IS_MCPB: "1" },
      secretEnv: [],
    },
    startupTimeoutMs: 30000,
    toolTimeoutMs: 60000,
    idleTimeoutMs: 300000,
    restartPolicy: "on_failure",
    tools: {},
    createdAt: now,
    updatedAt: now,
  };
  return { version: 1, servers: [resolve] };
}

/** Drops entries a hand-edited config could not run, instead of crashing the panel. */
function normalizeServer(entry: unknown): MCPServerConfig | null {
  if (!entry || typeof entry !== "object") return null;
  const server = entry as Record<string, any>;
  if (typeof server.id !== "string" || !server.id) return null;
  if (server.transport !== "stdio" && server.transport !== "streamable_http") return null;
  const connection = server.connection;
  if (!connection || typeof connection !== "object") return null;
  if (server.transport === "stdio") {
    if (typeof connection.command !== "string" || !connection.command) return null;
    connection.args = Array.isArray(connection.args) ? connection.args.map((arg: unknown) => String(arg)) : [];
  } else if (typeof connection.url !== "string" || !connection.url) {
    return null;
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

export function defaultBridgeSettings(): BridgeSettings {
  return {
    baseUrl: process.env.LLAMA_BASE || "http://127.0.0.1:8080",
    model: "",
    maxRounds: 5,
    toolTimeoutMs: 60000,
    requestTimeoutMs: 600000,
  };
}

export function loadBridgeSettings(): BridgeSettings {
  const defaults = defaultBridgeSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
    const merged: BridgeSettings = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof BridgeSettings)[]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === typeof defaults[key]) {
        (merged as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return merged;
  } catch {
    return defaults;
  }
}

export function saveBridgeSettings(settings: BridgeSettings): void {
  atomicWrite(BRIDGE_FILE, settings);
}
