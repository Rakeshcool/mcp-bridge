import http from "node:http";
import { EventEmitter } from "node:events";
import {
  defaultConnectionsSettings,
  defaultDiscoverySettings,
  loadBridgeSettings,
  loadConfig,
  saveBridgeSettings,
  saveConfig,
} from "./config.ts";
import { Registry } from "./registry.ts";
import { ApprovalService } from "./approvals.ts";
import { ActivityStore } from "./activity.ts";
import { setLogRedactor } from "./logs.ts";
import { migrateInlineSecrets, redact } from "./secrets.ts";
import { DiscoveryManager } from "./discovery.ts";
import { CONNECTOR_PATH, ConnectorHub } from "./mcp/connector.ts";
import { checkHost, handleApi, handleBridge, serveStatic } from "./api.ts";
import { handleMcpEndpoint, MCP_ENDPOINT_PATH } from "./mcp/server.ts";
import { DEFAULT_PORT } from "./constants.ts";
import { upstreamStatus } from "./upstream.ts";
import type { BridgeSettings } from "./types.ts";

setLogRedactor(redact);

const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
const events = new EventEmitter();
events.setMaxListeners(64);

const config = loadConfig();
let settings: BridgeSettings = loadBridgeSettings();

// Configs written before the secretEnv round-trip carried credentials inline; move them out
// before anything can log or copy the file. The Discord entry is the one this applies to here.
if (migrateInlineSecrets(config.servers) > 0) saveConfig({ version: 1, servers: config.servers });

// The connector hub is what turns a live panel socket into an `MCPClient`; the registry asks it
// before ever launching anything, so a dialled-in application needs no process of its own.
let connector: ConnectorHub | null = null;

const registry = new Registry(
  config.servers,
  events,
  () => {
    saveConfig({ version: 1, servers: registry.servers });
  },
  () => settings.connections ?? defaultConnectionsSettings(),
  (id) => connector?.take(id) ?? null,
);
const approvals = new ApprovalService(events);
const activity = new ActivityStore(events);

const discovery = new DiscoveryManager({
  registry,
  events,
  getSettings: () => settings.discovery ?? defaultDiscoverySettings(),
});

connector = new ConnectorHub({
  registry,
  requireApproval: () => (settings.discovery ?? defaultDiscoverySettings()).requireApproval,
  token: process.env.MCP_BRIDGE_CONNECTOR_TOKEN ?? "",
  enabled: process.env.MCP_BRIDGE_CONNECTOR !== "0",
  log: (level, message) => events.emit("event", { type: "log", data: { level, message, scope: "connector" } }),
});

const ctx = {
  registry,
  events,
  approvals,
  activity,
  discovery,
  connector,
  getSettings: () => settings,
  setSettings: (next: BridgeSettings) => {
    settings = next;
    saveBridgeSettings(next);
    events.emit("event", { type: "bridge", data: next });
  },
};

const PASSTHROUGH = new Set(["/props", "/health", "/metrics", "/tokenize", "/detokenize", "/slots"]);

const server = http.createServer((req, res) => {
  void (async () => {
    if (!checkHost(req)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden: the bridge only accepts loopback requests.\n");
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    try {
      if (url.pathname === MCP_ENDPOINT_PATH) {
        await handleMcpEndpoint(req, res, ctx);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, ctx);
        return;
      }
      if (url.pathname.startsWith("/v1/") || PASSTHROUGH.has(url.pathname)) {
        await handleBridge(req, res, url, ctx);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        serveStatic(req, res, url);
        return;
      }
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method not allowed\n");
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { code: "MCP_INTERNAL_ERROR", message: (error as Error).message } }));
      } else {
        res.end();
      }
    }
  })();
});

connector.attach(server);

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`[mcp-bridge] panel     http://127.0.0.1:${actualPort}`);
  console.log(`[mcp-bridge] base_url  http://127.0.0.1:${actualPort}/v1`);
  console.log(`[mcp-bridge] mcp       http://127.0.0.1:${actualPort}${MCP_ENDPOINT_PATH}`);
  console.log(`[mcp-bridge] upstream  ${settings.baseUrl}`);
  console.log(`[mcp-bridge] registrations ${discovery.directory()}`);
  console.log(`[mcp-bridge] connector ws://127.0.0.1:${actualPort}${CONNECTOR_PATH}`);
  discovery.start();
  // Approved servers come back after a restart only when the user asked for it; the bridge
  // has always connected lazily otherwise.
  if (settings.connections?.autoConnect) {
    for (const server of registry.servers) {
      if (!server.enabled || !registry.isApproved(server) || server.manifestMissing) continue;
      void registry.connect(server.id).catch(() => undefined);
    }
  }
  void upstreamStatus(settings.baseUrl).then((status) => {
    if (status.reachable) console.log(`[mcp-bridge] llama-server reachable, model: ${status.model || "(unknown)"}`);
    else console.warn(`[mcp-bridge] llama-server not reachable yet: ${status.error ?? "unknown error"}`);
  });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mcp-bridge] ${signal} received, stopping MCP processes…`);
  discovery.stop();
  connector?.stop();
  try {
    await registry.shutdown();
  } catch {
    // ignore
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
