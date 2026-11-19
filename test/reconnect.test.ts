/**
 * Guards the two reconnect paths against a server that idle-stops between discovery and the
 * call: POST /api/tools/<name>/call, and tools/call over the aggregated /mcp endpoint while an
 * `ask` approval is pending.
 *
 * Everything runs in this process against test/echo-stub.mjs on an ephemeral port. The registry
 * gets a no-op persist callback, so nothing here reads or writes data/servers.json.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ActivityStore } from "../src/server/activity.ts";
import { handleApi } from "../src/server/api.ts";
import { ApprovalService } from "../src/server/approvals.ts";
import { MCP_ENDPOINT_PATH, handleMcpEndpoint } from "../src/server/mcp/server.ts";
import { StreamableHttpClient } from "../src/server/mcp/streamable.ts";
import { Registry } from "../src/server/registry.ts";
import type { BridgeSettings, MCPServerConfig } from "../src/server/types.ts";

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "echo-stub.mjs");
const TOOL = "echo__say";

const events = new EventEmitter();
events.setMaxListeners(64);
const registry = new Registry(
  [
    {
      id: "echo",
      name: "Echo stub",
      enabled: true,
      visibility: "normal",
      transport: "stdio",
      connection: { command: process.execPath, args: [STUB] },
      // The shortest idle the bridge accepts, so the stop happens inside a test.
      idleTimeoutMs: 1000,
      startupTimeoutMs: 15000,
      toolTimeoutMs: 15000,
      restartPolicy: "never",
      tools: { say: { enabled: true, permission: "allow" } },
    } satisfies MCPServerConfig,
  ],
  events,
  () => {},
);

let settings: BridgeSettings = {
  baseUrl: "http://127.0.0.1:9",
  model: "",
  maxRounds: 5,
  toolTimeoutMs: 15000,
  requestTimeoutMs: 60000,
};

const approvals = new ApprovalService(events, 10000);
const activity = new ActivityStore(events);
const ctx = {
  registry,
  events,
  approvals,
  activity,
  getSettings: () => settings,
  setSettings: (next: BridgeSettings) => {
    settings = next;
  },
};

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === MCP_ENDPOINT_PATH) {
        await handleMcpEndpoint(req, res, ctx);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, ctx);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: (error as Error).message } }));
      } else {
        res.end();
      }
    }
  })();
});

let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await registry.connect("echo");
});

after(async () => {
  await registry.shutdown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("POST /api/tools/<name>/call reconnects a server that idle-stopped first", async () => {
  const first = await post(`/api/tools/${TOOL}/call`, { text: "direct" });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.result, "echo: direct");
  assert.equal("reconnected" in first.body, false, "a call to a connected server must not claim a reconnect");

  await waitFor("the stub to idle-stop", () => registry.view("echo").status === "disconnected");

  const second = await post(`/api/tools/${TOOL}/call`, { text: "after idle" });
  assert.equal(second.status, 200);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.result, "echo: after idle");
  assert.equal(second.body.reconnected, true);
  assert.equal(registry.view("echo").status, "connected");

  // The same stop can land in the microseconds between resolveDirectTool and the call.
  // It is too narrow to hit by timing, so fail the first call once and check the route
  // retries it instead of turning that into a 500 for the caller.
  const original = registry.callTool.bind(registry);
  let failedOnce = false;
  registry.callTool = async (serverId: string, toolName: string, args: unknown, timeoutMs: number) => {
    if (!failedOnce) {
      failedOnce = true;
      throw new Error("MCP_SERVER_NOT_CONNECTED: echo is not connected");
    }
    return original(serverId, toolName, args, timeoutMs);
  };
  try {
    const raced = await post(`/api/tools/${TOOL}/call`, { text: "raced" });
    assert.equal(raced.status, 200);
    assert.equal(raced.body.ok, true);
    assert.equal(raced.body.result, "echo: raced");
    assert.equal(raced.body.reconnected, true);
  } finally {
    registry.callTool = original;
  }
});

test("/mcp reconnects when the server idle-stops while an approval is pending", async () => {
  registry.patchTool(TOOL, { permission: "ask" });
  let approvalId: string | undefined;
  const onEvent = (payload: { type: string; data?: Record<string, any> }) => {
    if (payload.type === "approval_requested" && payload.data?.exposedName === TOOL) approvalId = payload.data.id;
  };
  events.on("event", onEvent);

  const client = new StreamableHttpClient(
    {
      id: "test-client",
      name: "test client",
      enabled: true,
      visibility: "normal",
      transport: "streamable_http",
      connection: { url: `${base}/mcp` },
    } satisfies MCPServerConfig,
    { serverId: "test-client", log: () => {}, env: {}, startupTimeoutMs: 15000, onExit: () => {}, onToolsChanged: () => {} },
    {},
  );

  try {
    await client.connect();
    assert.ok((await client.listTools()).some((tool) => tool.name === TOOL), `${TOOL} should be listed over /mcp`);

    const call = client.callTool(TOOL, { text: "gap" }, 30000).catch((error: unknown) => {
      throw new Error(`tool call failed instead of retrying: ${(error as Error).message}`);
    });
    await waitFor("the approval request", () => approvalId !== undefined);
    await waitFor("the stub to idle-stop during the approval wait", () => registry.view("echo").status === "disconnected");

    assert.equal(approvals.resolve(approvalId!, true), true, "approval should still be pending");
    const result = await call;
    assert.equal(result.isError, false, result.text);
    assert.equal(result.text, "echo: gap");
    assert.equal(registry.view("echo").status, "connected");
  } finally {
    events.off("event", onEvent);
    await client.close();
  }
});
