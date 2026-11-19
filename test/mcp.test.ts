/**
 * Drives the real `handleApi` and `handleMcpEndpoint` handlers against `test/echo-stub.mjs` over a
 * real socket on an ephemeral port, in this process.
 *
 * Reconnect cases: a server that idle-stops between discovery and the call must still run it — on
 * `POST /api/tools/<name>/call`, over `/mcp` while an approval is pending, and when several calls
 * race the same reconnect.
 *
 * Conformance cases: the promises README.md makes about `/mcp` — JSON-RPC replies and error codes,
 * `GET` 405, `DELETE` as a no-op, no session, permissions, image blocks, notifications, origins.
 *
 * The registry gets a no-op persist callback, so nothing here reads or writes `data/servers.json`,
 * and port 0 means it cannot collide with a bridge that is already running.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
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
const SHOT = "echo__shot";
const BOOM = "echo__boom";
const REPORT = "echo__report";
/** Keep in sync with test/echo-stub.mjs; importing it would run the stub in this process. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
      tools: {
        say: { enabled: true, permission: "allow" },
        shot: { enabled: true, permission: "allow" },
        boom: { enabled: true, permission: "allow" },
      },
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
let nextId = 1;

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

/** One JSON-RPC request against /mcp. */
async function rpc(
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** A raw request, for the shapes fetch would normalize away (method bodies, Origin). */
function raw(
  method: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}/mcp`, { method, headers: options.headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** Connects the stub again if an earlier case left it idle-stopped, so one failure stays local. */
async function ensureConnected(): Promise<void> {
  if (registry.view("echo").status !== "connected") await registry.connect("echo");
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Text of a tool result, or the JSON-RPC error, for failure messages. */
function describe(response: { body: any }): string {
  return response.body?.error ? `error ${response.body.error.code}: ${response.body.error.message}` : JSON.stringify(response.body?.result);
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

test("parallel calls to an idle-stopped server share one reconnect", async () => {
  registry.patchTool(TOOL, { permission: "allow" });
  await waitFor("the stub to idle-stop", () => registry.view("echo").status === "disconnected");

  const [one, two] = await Promise.all([
    rpc("tools/call", { name: TOOL, arguments: { text: "parallel a" } }),
    rpc("tools/call", { name: TOOL, arguments: { text: "parallel b" } }),
  ]);

  assert.equal(one.body.error, undefined, describe(one));
  assert.equal(two.body.error, undefined, describe(two));
  assert.ok(!one.body.result.isError, describe(one));
  assert.ok(!two.body.result.isError, describe(two));
  assert.equal(one.body.result.content[0].text, "echo: parallel a");
  assert.equal(two.body.result.content[0].text, "echo: parallel b");
  assert.equal(registry.view("echo").status, "connected");
});

test("two concurrent calls to a stopped server share one reconnect instead of MCP_BUSY", async () => {
  // The race that used to return 409 needs both calls to fail against a stopped server at the
  // same moment, so it is driven at the helper both routes use rather than through two sockets:
  // the first reconnect starts and the second call joins it, with no HTTP scheduling in between.
  await waitFor("the stub to idle-stop", () => registry.view("echo").status === "disconnected");

  const [one, two] = await Promise.all([
    registry.callToolWithReconnect("echo", "say", { text: "shared a" }, 15000),
    registry.callToolWithReconnect("echo", "say", { text: "shared b" }, 15000),
  ]);

  assert.equal(one.result.isError, false, one.result.text);
  assert.equal(two.result.isError, false, two.result.text);
  assert.equal(one.result.text, "echo: shared a");
  assert.equal(two.result.text, "echo: shared b");
  assert.equal(one.reconnected, true);
  assert.equal(two.reconnected, true);
  assert.equal(registry.view("echo").status, "connected");
});

test("initialize negotiates a protocol version and advertises tools", async () => {
  const supported = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.1" },
  });
  assert.equal(supported.body.result.protocolVersion, "2025-03-26");
  assert.deepEqual(supported.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(supported.body.result.serverInfo.name, "llama-mcp-bridge");
  assert.match(supported.body.result.instructions, /serverId__toolName/);

  const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.body.result.protocolVersion, "2025-06-18", "an unknown version is answered with ours");
});

test("tools/list exposes the catalog and the endpoint keeps no session", async () => {
  await ensureConnected();
  const listed = await rpc("tools/list", {});
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("mcp-session-id"), null, "a stateless endpoint must not issue a session id");
  const names = listed.body.result.tools.map((tool: any) => tool.name);
  assert.deepEqual([...names].sort(), [BOOM, REPORT, SHOT, TOOL].sort());
  const say = listed.body.result.tools.find((tool: any) => tool.name === TOOL);
  assert.equal(say.inputSchema.type, "object");
  assert.ok(say.description);
  assert.equal("title" in say, false, "a tool without a title must not gain one");
  assert.equal("outputSchema" in say, false);

  // Everything the owning server published reaches the client, as if it were connected directly.
  const report = listed.body.result.tools.find((tool: any) => tool.name === REPORT);
  assert.equal(report.title, "Report");
  assert.deepEqual(report.outputSchema, {
    type: "object",
    properties: { answer: { type: "number" } },
    required: ["answer"],
  });
  assert.deepEqual(report.annotations, { readOnlyHint: true, openWorldHint: false });

  // A client that echoes a session id is still answered: nothing is stored per client.
  const withSession = await rpc("tools/list", {}, { "mcp-session-id": "not-a-session" });
  assert.equal(withSession.status, 200);
  assert.equal(withSession.body.result.tools.length, 4);
});

test("GET answers 405, DELETE is a no-op, and ping is implemented", async () => {
  const get = await raw("GET");
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, "POST, DELETE");
  assert.match(String(get.headers["content-type"]), /^text\/plain/);
  assert.match(get.text, /does not open a server-initiated SSE stream/);

  const del = await raw("DELETE");
  assert.equal(del.status, 200);
  assert.deepEqual(JSON.parse(del.text), { jsonrpc: "2.0", result: {} });

  const ping = await rpc("ping", {});
  assert.deepEqual(ping.body.result, {});
});

test("unknown tools and malformed arguments are JSON-RPC errors", async () => {
  const unknown = await rpc("tools/call", { name: "echo__nope", arguments: {} });
  assert.equal(unknown.body.error.code, -32602);
  assert.match(unknown.body.error.message, /Unknown tool: echo__nope/);
  assert.match(unknown.body.error.data.hint, /tools\/list/);

  const badArgs = await rpc("tools/call", { name: TOOL, arguments: [] });
  assert.equal(badArgs.body.error.code, -32602);
  assert.match(badArgs.body.error.message, /must be an object/);

  const noName = await rpc("tools/call", { arguments: {} });
  assert.equal(noName.body.error.code, -32602);
});

test("malformed requests get the JSON-RPC codes the README lists", async () => {
  const parse = await raw("POST", { headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(parse.status, 200);
  assert.equal(JSON.parse(parse.text).error.code, -32700);

  const batch = await raw("POST", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
  });
  assert.equal(JSON.parse(batch.text).error.code, -32600);

  const wrongVersion = await raw("POST", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: 2, method: "ping" }),
  });
  assert.equal(JSON.parse(wrongVersion.text).error.code, -32600);
});

test("notifications are accepted with 202 and no reply", async () => {
  const notification = await raw("POST", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notification.status, 202);
  assert.equal(notification.text, "");
});

test("cross-origin requests are refused and loopback origins are allowed", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const foreign = await raw("POST", {
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body,
  });
  assert.equal(foreign.status, 403);
  assert.equal(JSON.parse(foreign.text).error.code, -32000);

  const loopback = await raw("POST", {
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:7800" },
    body,
  });
  assert.equal(loopback.status, 200);
  assert.deepEqual(JSON.parse(loopback.text).result, {});
});

test("permission levels decide what /mcp runs", async () => {
  await ensureConnected();
  registry.patchTool(TOOL, { permission: "deny" });
  const denied = await rpc("tools/call", { name: TOOL, arguments: { text: "x" } });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /Deny/);

  registry.patchTool(TOOL, { permission: "allow", enabled: false });
  const disabled = await rpc("tools/call", { name: TOOL, arguments: { text: "x" } });
  assert.equal(disabled.body.result.isError, true);
  assert.match(disabled.body.result.content[0].text, /disabled/);

  registry.patchTool(TOOL, { permission: "ask", enabled: true });
  let approvalId: string | undefined;
  const onEvent = (payload: { type: string; data?: Record<string, any> }) => {
    if (payload.type === "approval_requested" && payload.data?.exposedName === TOOL) approvalId = payload.data.id;
  };
  events.on("event", onEvent);
  try {
    const pending = rpc("tools/call", { name: TOOL, arguments: { text: "declined" } });
    await waitFor("the approval request", () => approvalId !== undefined);
    approvals.resolve(approvalId!, false);
    const declined = await pending;
    assert.equal(declined.body.result.isError, true);
    assert.match(declined.body.result.content[0].text, /declined/);
  } finally {
    events.off("event", onEvent);
    registry.patchTool(TOOL, { permission: "allow" });
  }
});

test("structured results keep structuredContent next to the text", async () => {
  await ensureConnected();
  const report = await rpc("tools/call", { name: REPORT, arguments: {} });
  assert.deepEqual(report.body.result.structuredContent, { answer: 42 });
  assert.equal(report.body.result.content[0].text, "answer: 42");

  const plain = await rpc("tools/call", { name: TOOL, arguments: { text: "no structure" } });
  assert.equal("structuredContent" in plain.body.result, false, "a text-only result must not gain a structure");
});

test("image blocks keep their mime type and bytes, and tool errors stay errors", async () => {
  await ensureConnected();
  const shot = await rpc("tools/call", { name: SHOT, arguments: {} });
  assert.deepEqual(
    shot.body.result.content.map((block: any) => block.type),
    ["text", "image"],
  );
  assert.match(shot.body.result.content[0].text, /^shot\n\[image image\/png, \d+ KB\]$/);
  assert.equal(shot.body.result.content[1].mimeType, "image/png");
  assert.equal(shot.body.result.content[1].data, PNG);

  const boom = await rpc("tools/call", { name: BOOM, arguments: {} });
  assert.equal(boom.body.result.isError, true);
  assert.equal(boom.body.result.content[0].text, "boom");
});
