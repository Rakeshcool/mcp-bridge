/**
 * Connector transport tests.
 *
 * These run a real HTTP server with the real `ConnectorHub` attached, a real `Registry`, and a
 * WebSocket client that plays the part of an application panel (After Effects' CEP panel speaks
 * exactly this protocol). Nothing is stubbed on the bridge side, so the tests cover the upgrade,
 * the registration, the approval gate, tool discovery and a full tool call round trip.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { WebSocket } from "ws";
import { CONNECTOR_PATH, ConnectorHub, parseRegistration } from "../src/server/mcp/connector.ts";
import { Registry } from "../src/server/registry.ts";
import type { MCPServerConfig } from "../src/server/types.ts";

const CONNECTIONS = { autoConnect: false, autoReconnect: false, maxRetries: 0 };

const TOOLS = [
  {
    name: "list-compositions",
    description: "List the compositions in the open project",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create-composition",
    description: "Create a composition",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, width: { type: "number" } },
      required: ["name"],
    },
  },
];

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "register",
    protocol: 1,
    server: { id: "after-effects", name: "After Effects", description: "AE panel" },
    application: { name: "Adobe After Effects", version: "26.3", extensionType: "CEP" },
    capabilities: ["compositions", "layers"],
    tools: TOOLS,
    ...overrides,
  };
}

/** What a tool call handler returns: a value, or `{ error }` to report a failed call. */
type CallReply = unknown;

/** A panel: connects, registers, records frames and answers calls the way the real panel does. */
class FakePanel {
  readonly ws: WebSocket;
  private frames: any[] = [];
  private cursor = 0;
  private closed = false;
  onCall: (frame: { id: number; name: string; arguments: Record<string, unknown> }) => CallReply = () => "ok";

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async connect(port: number, options: { token?: string } = {}): Promise<FakePanel> {
    const query = options.token ? `?token=${encodeURIComponent(options.token)}` : "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}${CONNECTOR_PATH}${query}`);
    const panel = new FakePanel(ws);
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "call") {
        const reply = panel.onCall(frame);
        ws.send(JSON.stringify(panelResult(frame.id, reply)));
        return;
      }
      panel.frames.push(frame);
    });
    ws.on("close", () => {
      panel.closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return panel;
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  register(overrides: Record<string, unknown> = {}): void {
    this.send(registration(overrides));
  }

  async nextFrame(type: string, timeoutMs = 4000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.frames.length) {
        const frame = this.frames[this.cursor++];
        if (frame.type === type) return frame;
      }
      if (this.closed || Date.now() > deadline) {
        throw new Error(`timed out waiting for a "${type}" frame (closed=${this.closed})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  close(): void {
    try {
      this.ws.terminate();
    } catch {
      // already gone
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function panelResult(id: number, reply: CallReply): Record<string, unknown> {
  if (reply && typeof reply === "object" && typeof (reply as { error?: unknown }).error === "string") {
    return { type: "result", id, ok: false, error: (reply as { error: string }).error };
  }
  if (typeof reply === "string") return { type: "result", id, ok: true, text: reply };
  return { type: "result", id, ok: true, result: reply };
}

async function waitForStatus(registry: Registry, id: string, status: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (registry.view(id).status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for "${id}" to become ${status}; it is ${registry.view(id).status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Harness {
  port: number;
  registry: Registry;
  hub: ConnectorHub;
  servers: MCPServerConfig[];
  close: () => Promise<void>;
}

async function harness(options: { token?: string; requireApproval?: boolean; servers?: MCPServerConfig[] } = {}): Promise<Harness> {
  const events = new EventEmitter();
  const servers = options.servers ?? [];
  let hub: ConnectorHub;
  const registry = new Registry(
    servers,
    events,
    () => undefined,
    () => CONNECTIONS,
    (id) => hub.take(id),
  );
  hub = new ConnectorHub({
    registry,
    requireApproval: () => options.requireApproval !== false,
    token: options.token,
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    registry,
    hub,
    servers,
    close: async () => {
      hub.stop();
      await registry.shutdown();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Every test tears its server and panels down, so one failed assertion cannot leak sockets. */
async function setup(t: TestContext, options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness(options);
  t.after(async () => {
    await h.close();
  });
  return h;
}

test("parseRegistration accepts a panel registration and refuses the rest", () => {
  const good = parseRegistration(registration());
  assert.ok(good.ok, good.ok ? "" : good.error);
  assert.equal(good.value.server.id, "after-effects");
  assert.equal(good.value.tools.length, 2);
  assert.equal(good.value.application?.extensionType, "CEP");

  const cases: Array<[string, unknown]> = [
    ["wrong protocol", registration({ protocol: 2 })],
    ["missing type", { ...registration(), type: "hello" }],
    ["bad id", registration({ server: { id: "After Effects", name: "AE" } })],
    ["missing name", registration({ server: { id: "after-effects" } })],
    ["tools not an array", registration({ tools: {} })],
    ["duplicate tool", registration({ tools: [TOOLS[0], TOOLS[0]] })],
    ["nameless tool", registration({ tools: [{ description: "x" }] })],
    ["application without name", registration({ application: { version: "1" } })],
    ["capabilities not strings", registration({ capabilities: [1, 2] })],
  ];
  for (const [label, payload] of cases) {
    assert.equal(parseRegistration(payload).ok, false, `${label} should be refused`);
  }
});

test("a panel registers, is held for approval, and cannot run tools until approved", async (t) => {
  const h = await setup(t);
  const panel = await FakePanel.connect(h.port);
  t.after(() => panel.close());
  panel.register();

  const registered = await panel.nextFrame("registered");
  assert.equal(registered.serverId, "after-effects");
  assert.equal(registered.approved, false, "approval is required by default");
  assert.equal(registered.status, "pending_approval");

  const server = h.registry.find("after-effects");
  assert.ok(server, "the application must be recorded");
  assert.equal(server?.transport, "connector");
  assert.equal(server?.source, "connector");
  assert.equal(h.registry.view("after-effects").status, "pending_approval");
  assert.equal(h.registry.catalog().length, 0, "unapproved tools must not be exposed");
  assert.equal(h.hub.take("after-effects")?.toolCount, 2, "the socket is live while waiting");

  await assert.rejects(
    () => h.registry.connect("after-effects"),
    (error: any) => error?.code === "MCP_APPROVAL_REQUIRED",
  );

  h.registry.setApproval("after-effects", true);
  await h.registry.connect("after-effects");
  assert.equal(h.registry.view("after-effects").status, "connected");
  const names = h.registry.catalog().map((entry) => entry.exposedName).sort();
  assert.deepEqual(names, ["after-effects__create-composition", "after-effects__list-compositions"]);
});

test("a tool call travels over the socket and its result comes back", async (t) => {
  const h = await setup(t, { requireApproval: false });
  const panel = await FakePanel.connect(h.port);
  t.after(() => panel.close());
  const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  panel.onCall = (frame) => {
    seen.push({ name: frame.name, args: frame.arguments });
    return { composition: "Main", layers: 3 };
  };
  panel.register();
  await panel.nextFrame("registered");

  assert.equal(h.registry.view("after-effects").status, "connected", "auto-approval connects immediately");
  const result = await h.registry.callTool("after-effects", "create-composition", { name: "Main" }, 5000);
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.text), { composition: "Main", layers: 3 });
  assert.deepEqual(seen, [{ name: "create-composition", args: { name: "Main" } }]);

  panel.onCall = () => ({ error: "After Effects is busy" });
  const failed = await h.registry.callTool("after-effects", "list-compositions", {}, 5000);
  assert.equal(failed.isError, true);
  assert.match(failed.text, /busy/);
});

test("a reconnecting panel keeps its approval and replaces the old session", async (t) => {
  const h = await setup(t);
  const first = await FakePanel.connect(h.port);
  t.after(() => first.close());
  first.register();
  await first.nextFrame("registered");
  h.registry.setApproval("after-effects", true);
  await h.registry.connect("after-effects");

  const second = await FakePanel.connect(h.port);
  t.after(() => second.close());
  second.register();
  const registered = await second.nextFrame("registered");
  assert.equal(registered.approved, true, "a known application does not need approval again");

  const third = await FakePanel.connect(h.port);
  t.after(() => third.close());
  third.register();
  await third.nextFrame("registered");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(h.hub.info().connections.length, 1, "only one live session per application");
  const result = await h.registry.callTool("after-effects", "list-compositions", {}, 5000);
  assert.equal(result.isError, false, "calls go to the newest panel");

  third.close();
  await waitForStatus(h.registry, "after-effects", "disconnected");
  assert.equal(h.registry.view("after-effects").toolCount, 0, "a closed panel exposes no tools");
});

test("an application cannot register over a server id that is already a process", async (t) => {
  const existing: MCPServerConfig = {
    id: "after-effects",
    name: "After Effects (stdio)",
    enabled: true,
    visibility: "normal",
    transport: "stdio",
    connection: { command: process.execPath, args: ["index.js"] },
  };
  const h = await setup(t, { servers: [existing] });
  const panel = await FakePanel.connect(h.port);
  t.after(() => panel.close());
  panel.register();
  const error = await panel.nextFrame("error");
  assert.equal(error.code, "MCP_CONNECTOR_CONFLICT");
  assert.equal(h.registry.find("after-effects")?.transport, "stdio", "the existing server is untouched");
});

test("an invalid registration is refused with a reason", async (t) => {
  const h = await setup(t);
  const panel = await FakePanel.connect(h.port);
  t.after(() => panel.close());
  panel.register({ protocol: 99 });
  const error = await panel.nextFrame("error");
  assert.equal(error.code, "MCP_CONNECTOR_INVALID");
  assert.match(error.message, /protocol/);
});

test("a shared token is enforced before registration", async (t) => {
  const h = await setup(t, { token: "s3cret-token" });
  const wrong = await FakePanel.connect(h.port, { token: "nope" }).then(
    () => null,
    (error: Error) => error,
  );
  assert.ok(wrong, "a wrong token must not open a socket");
  assert.match(String(wrong), /401/);

  const right = await FakePanel.connect(h.port, { token: "s3cret-token" });
  t.after(() => right.close());
  right.register();
  const registered = await right.nextFrame("registered");
  assert.equal(registered.serverId, "after-effects");
});

test("a panel that announces a changed tool set updates the catalog", async (t) => {
  const h = await setup(t, { requireApproval: false });
  const panel = await FakePanel.connect(h.port);
  t.after(() => panel.close());
  panel.register();
  await panel.nextFrame("registered");
  assert.equal(h.registry.view("after-effects").toolCount, 2);

  panel.send({ type: "tools", tools: [TOOLS[0]] });
  const deadline = Date.now() + 3000;
  while (h.registry.view("after-effects").toolCount !== 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(h.registry.view("after-effects").toolCount, 1);
});
