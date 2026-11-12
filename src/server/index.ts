import http from "node:http";
import { EventEmitter } from "node:events";
import { loadBridgeSettings, loadConfig, saveBridgeSettings, saveConfig } from "./config.ts";
import { Registry } from "./registry.ts";
import { ApprovalService } from "./approvals.ts";
import { ActivityStore } from "./activity.ts";
import { setLogRedactor } from "./logs.ts";
import { redact } from "./secrets.ts";
import { checkHost, handleApi, handleBridge, serveStatic } from "./api.ts";
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

const registry = new Registry(config.servers, events, () => {
  saveConfig({ version: 1, servers: registry.servers });
});
const approvals = new ApprovalService(events);
const activity = new ActivityStore(events);

const ctx = {
  registry,
  events,
  approvals,
  activity,
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

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`[mcp-bridge] panel     http://127.0.0.1:${actualPort}`);
  console.log(`[mcp-bridge] base_url  http://127.0.0.1:${actualPort}/v1`);
  console.log(`[mcp-bridge] upstream  ${settings.baseUrl}`);
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
