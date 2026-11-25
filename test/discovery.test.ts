/**
 * Discovery, approval and lifecycle tests.
 *
 * Everything runs against a temporary registration directory and a temporary ignore file, so the
 * real `data/` folder is untouched. The stdio stubs are real child processes speaking newline
 * JSON-RPC, so the approval gate is exercised through the same `Registry.connect` path the panel uses.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DiscoveryManager, defaultRegistrationDir, validateManifest } from "../src/server/discovery.ts";
import { Registry, reconnectDelay } from "../src/server/registry.ts";
import { mergeConnectionsSettings, mergeDiscoverySettings } from "../src/server/config.ts";
import { isSecretKey } from "../src/server/secrets.ts";
import type { ConnectionsSettings, DiscoverySettings, MCPServerConfig } from "../src/server/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOTTED = path.join(HERE, "dotted-stub.mjs");

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcp-bridge-${label}-`));
}

interface Harness {
  dir: string;
  settings: DiscoverySettings;
  connections: ConnectionsSettings;
  registry: Registry;
  discovery: DiscoveryManager;
  events: EventEmitter;
  /** How many times the registry has written servers.json. */
  persisted: () => number;
}

function harness(label: string, servers: MCPServerConfig[] = []): Harness {
  const dir = path.join(tempDir(label), "servers");
  fs.mkdirSync(dir, { recursive: true });
  const events = new EventEmitter();
  const settings: DiscoverySettings = {
    enabled: true,
    watchRegistrationDirectory: false,
    autoRegister: false,
    requireApproval: true,
    directory: dir,
  };
  const connections: ConnectionsSettings = { autoConnect: false, autoReconnect: false, maxRetries: 0 };
  let persisted = 0;
  const registry = new Registry(servers, events, () => { persisted += 1; }, () => connections);
  const discovery = new DiscoveryManager({
    registry,
    events,
    getSettings: () => settings,
    stateFile: path.join(path.dirname(dir), "discovery.json"),
  });
  return { dir, settings, connections, registry, discovery, events, persisted: () => persisted };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { connection, ...rest } = overrides as { connection?: Record<string, unknown> };
  return {
    schemaVersion: 1,
    id: "stub-app",
    name: "Stub App",
    description: "Integration test manifest",
    application: { name: "Stub Application", version: "2026", extensionType: "CEP" },
    capabilities: ["things", "stuff"],
    ...rest,
    connection: {
      transport: "stdio",
      command: process.execPath,
      args: [DOTTED],
      ...(connection ?? {}),
    },
  };
}

function writeManifest(dir: string, name: string, body: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  return file;
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("validateManifest accepts a complete manifest and hashes only execution fields", () => {
  const file = path.join(tempDir("validate"), "stub.json");
  const first = validateManifest(manifest(), file);
  assert.ok(first.ok, first.ok ? "" : first.error);
  assert.equal(first.value.transport, "stdio");
  assert.equal(first.value.manifest.application?.name, "Stub Application");

  const renamed = validateManifest(manifest({ name: "Renamed", description: "other" }), file);
  assert.ok(renamed.ok);
  assert.equal(renamed.value.hash, first.value.hash, "metadata must not change the approval identity");

  const elsewhere = validateManifest(manifest(), path.join(tempDir("renamed"), "some-other-name.json"));
  assert.ok(elsewhere.ok);
  assert.equal(elsewhere.value.hash, first.value.hash, "renaming the manifest file must not change the approval identity");

  const differentArgs = validateManifest(manifest({ connection: { args: [DOTTED, "--x"] } }), file);
  assert.ok(differentArgs.ok);
  assert.notEqual(differentArgs.value.hash, first.value.hash, "arguments must change the approval identity");
});

test("validateManifest rejects the cases that would let a manifest run something unexpected", () => {
  const file = path.join(tempDir("reject"), "stub.json");
  const cases: Array<[string, Record<string, unknown>]> = [
    ["schema version", { schemaVersion: 2 }],
    ["transport", { connection: { transport: "websocket" } }],
    ["relative command", { connection: { command: "node" } }],
    ["missing executable", { connection: { command: path.join(os.tmpdir(), "nope-does-not-exist.exe") } }],
    ["traversal", { connection: { command: `${os.tmpdir()}\\..\\node.exe` } }],
    ["secret in env", { connection: { env: { DISCORD_BOT_TOKEN: "x" } } }],
    ["embedded url credentials", { connection: { transport: "streamable_http", url: "https://user:pass@example.com/mcp" } }],
    ["bad id", { id: "Not Valid" }],
  ];
  for (const [label, override] of cases) {
    const result = validateManifest(manifest(override), file);
    assert.equal(result.ok, false, `${label} should be rejected`);
  }
});

test("a discovered manifest is registered but cannot connect until it is approved", async () => {
  const h = harness("approve");
  writeManifest(h.dir, "stub.json", manifest());

  const state = await h.discovery.scan();
  assert.equal(state.entries[0].outcome, "pending_approval");
  const server = h.registry.find("stub-app");
  assert.ok(server, "manifest should be registered");
  assert.equal(server?.source, "manifest");
  assert.equal(server?.approved, false);
  assert.equal(h.registry.view("stub-app").status, "pending_approval");
  assert.equal(state.pending.length, 1);

  await assert.rejects(
    () => h.registry.connect("stub-app"),
    (error: any) => error?.code === "MCP_APPROVAL_REQUIRED",
    "connecting an unapproved server must be refused with MCP_APPROVAL_REQUIRED",
  );
  assert.equal(h.registry.catalog().length, 0, "unapproved servers expose no tools");

  const approved = await h.discovery.approve("stub-app", true);
  assert.equal(approved.ok, true, approved.error);
  assert.equal(h.registry.view("stub-app").status, "connected");
  const names = h.registry.catalog().map((entry) => entry.exposedName).sort();
  assert.deepEqual(names, ["stub-app__foo_bar", "stub-app__foo_bar__2"]);
  await h.registry.shutdown();
});

test("a manifest may not take over a hand-configured server with the same id", async () => {
  const manual: MCPServerConfig = {
    id: "stub-app",
    name: "My own server",
    enabled: true,
    visibility: "normal",
    transport: "stdio",
    connection: { command: process.execPath, args: [DOTTED] },
    tools: {},
  };
  const h = harness("conflict", [manual]);
  writeManifest(h.dir, "stub.json", manifest());

  const state = await h.discovery.scan();
  assert.equal(state.entries[0].outcome, "conflict");
  assert.match(state.entries[0].error ?? "", /hand-configured server/);
  assert.equal(h.registry.find("stub-app")?.name, "My own server");
  assert.equal(h.registry.find("stub-app")?.source, undefined);
});

test("an unchanged manifest keeps its approval; a changed command requires it again", async () => {
  const h = harness("update");
  const file = writeManifest(h.dir, "stub.json", manifest());
  await h.discovery.scan();
  await h.discovery.approve("stub-app", false);
  assert.equal(h.registry.find("stub-app")?.approved, true);

  // Metadata-only change: same executable, same args, new description.
  writeManifest(h.dir, "stub.json", manifest({ description: "updated copy", name: "Stub App 2" }));
  let state = await h.discovery.scan();
  assert.equal(state.entries[0].outcome, "unchanged");
  assert.equal(h.registry.find("stub-app")?.name, "Stub App 2");
  assert.equal(h.registry.find("stub-app")?.approved, true, "metadata refresh must not revoke approval");

  // Execution change: new argument means new code path, so approval is withdrawn.
  writeManifest(h.dir, "stub.json", manifest({ connection: { args: [DOTTED, "--dangerous"] } }));
  state = await h.discovery.scan();
  assert.equal(state.entries[0].outcome, "pending_approval");
  assert.equal(h.registry.find("stub-app")?.approved, false);
  assert.equal(h.registry.view("stub-app").status, "pending_approval");
  assert.equal(fs.existsSync(file), true);
});

test("a deleted manifest keeps the record and flags it instead of silently dropping it", async () => {
  const h = harness("missing");
  const file = writeManifest(h.dir, "stub.json", manifest());
  await h.discovery.scan();
  await h.discovery.approve("stub-app", false);

  fs.unlinkSync(file);
  const state = await h.discovery.scan();
  assert.equal(state.entries.length, 0);
  assert.equal(h.registry.find("stub-app")?.manifestMissing, true);
  assert.equal(h.registry.find("stub-app")?.approved, true);
});

test("invalid manifests are reported, not registered", async () => {
  const h = harness("invalid");
  writeManifest(h.dir, "broken.json", { schemaVersion: 1, id: "broken", name: "Broken", connection: { transport: "carrier-pigeon" } });
  fs.writeFileSync(path.join(h.dir, "not-json.json"), "{ nope", "utf8");

  const state = await h.discovery.scan();
  assert.equal(state.entries.length, 2);
  for (const entry of state.entries) assert.equal(entry.outcome, "invalid");
  assert.equal(h.registry.servers.length, 0);
});

test("an unavailable registration directory does not throw", async () => {
  const h = harness("blocked");
  // A file where the directory should be: exists, but is not a directory.
  fs.rmSync(h.dir, { recursive: true, force: true });
  fs.writeFileSync(h.dir, "not a directory", "utf8");

  const state = await h.discovery.scan();
  assert.equal(state.directoryAvailable, false);
  assert.equal(state.entries.length, 0);
});

test("forget removes the record and ignores that exact manifest until it changes", async () => {
  const h = harness("forget");
  writeManifest(h.dir, "stub.json", manifest());
  await h.discovery.scan();
  await h.discovery.approve("stub-app", false);

  const forgotten = await h.discovery.forget("stub-app");
  assert.equal(forgotten.ok, true, forgotten.error);
  assert.equal(h.registry.find("stub-app"), undefined);
  assert.ok(h.discovery.state().ignored["stub-app"]);

  let state = await h.discovery.scan();
  assert.equal(state.entries[0].outcome, "ignored");
  assert.equal(h.registry.find("stub-app"), undefined);

  // A different manifest for the same id is a new decision, so it comes back.
  writeManifest(h.dir, "stub.json", manifest({ connection: { args: [DOTTED, "--v2"] } }));
  state = await h.discovery.scan();
  assert.equal(state.entries[0].outcome, "pending_approval");
  assert.equal(h.discovery.state().ignored["stub-app"], undefined);
});

test("tool names that sanitize to the same string stay distinct in the catalog", async () => {
  const events = new EventEmitter();
  const registry = new Registry(
    [
      {
        id: "stub-app",
        name: "Dotted",
        enabled: true,
        visibility: "normal",
        transport: "stdio",
        connection: { command: process.execPath, args: [DOTTED] },
        tools: {},
        startupTimeoutMs: 15000,
        toolTimeoutMs: 15000,
        restartPolicy: "never",
      } satisfies MCPServerConfig,
    ],
    events,
    () => {},
  );
  await registry.connect("stub-app");
  const names = registry.view("stub-app").tools.map((tool) => tool.exposedName);
  assert.equal(new Set(names).size, names.length, "exposed names must be unique");

  const catalog = registry.catalog();
  assert.equal(catalog.length, 2);
  for (const entry of catalog) {
    const resolved = await registry.resolveDirectTool(entry.exposedName);
    assert.equal(resolved?.entry.toolName, entry.toolName, `${entry.exposedName} must resolve to its own tool`);
  }
  await registry.shutdown();
});

test("a scan with nothing new does not rewrite the server list, and a rename keeps approval", async () => {
  const h = harness("idle-scan");
  writeManifest(h.dir, "stub.json", manifest());
  await h.discovery.scan();
  const approved = await h.discovery.approve("stub-app", false);
  assert.equal(approved.ok, true, approved.error);

  const before = h.persisted();
  await h.discovery.scan();
  await h.discovery.scan();
  assert.equal(h.persisted(), before, "rescanning an unchanged manifest must not persist again");

  // A rename changes the file, not what will be executed: the approval survives, the new path is recorded once.
  const renamed = path.join(h.dir, "renamed.json");
  fs.renameSync(path.join(h.dir, "stub.json"), renamed);
  const state = await h.discovery.scan();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].outcome, "unchanged");
  assert.equal(h.registry.find("stub-app")?.approved, true, "a rename must not revoke approval");
  assert.equal(h.registry.find("stub-app")?.manifestPath, renamed);
  assert.equal(h.persisted(), before + 1, "the new manifest path persists once");

  await h.discovery.scan();
  assert.equal(h.persisted(), before + 1, "and not again on the next scan");
});

test("retry timing is exponential, capped, and jittered", () => {
  const none = () => 0;
  assert.equal(reconnectDelay(1, none), 1000);
  assert.equal(reconnectDelay(2, none), 2000);
  assert.equal(reconnectDelay(3, none), 4000);
  assert.equal(reconnectDelay(5, none), 16000);
  assert.equal(reconnectDelay(10, none), 30000, "must cap at 30s");
  const jittered = reconnectDelay(1);
  assert.ok(jittered >= 1000 && jittered <= 1250, `unexpected jitter: ${jittered}`);
});

test("settings merge is tolerant of hand-edited values and clamps them", () => {
  assert.deepEqual(mergeDiscoverySettings(undefined), {
    enabled: true,
    watchRegistrationDirectory: true,
    autoRegister: false,
    requireApproval: true,
  });
  const merged = mergeDiscoverySettings({ enabled: "yes", autoRegister: true, directory: "  D:/regs  " });
  assert.equal(merged.enabled, true, "non-boolean falls back to the default");
  assert.equal(merged.autoRegister, true);
  assert.equal(merged.directory, "D:/regs");

  const connections = mergeConnectionsSettings({ maxRetries: 999 });
  assert.equal(connections.maxRetries, 20);
});

test("secret-looking names are recognised, ordinary ones are not", () => {
  for (const name of ["DISCORD_BOT_TOKEN", "OPENAI_API_KEY", "MY_SECRET", "DB_PASSWORD", "GITHUB_AUTH"]) {
    assert.equal(isSecretKey(name), true, name);
  }
  for (const name of ["PATH", "NODE_OPTIONS", "DISCORD_MCP_CONFIG", "HOME"]) {
    assert.equal(isSecretKey(name), false, name);
  }
});

test("the default registration directory is per-user and platform-correct", () => {
  const dir = defaultRegistrationDir();
  assert.ok(path.isAbsolute(dir), dir);
  assert.match(dir, /MCPBridge[\\/]servers$/);
});
