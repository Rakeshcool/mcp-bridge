#!/usr/bin/env node
/**
 * mcp.mjs — start the MCP bridge and talk to its MCP tools directly.
 *
 * Built for AI agents: every command prints one JSON document to stdout and
 * exits 0 on success, 1 on failure, 2 on bad usage. Progress notes go to stderr
 * so stdout stays parseable.
 *
 *   node scripts/mcp.mjs up                 # start the bridge (idempotent) + connect servers
 *   node scripts/mcp.mjs servers            # which servers are configured and up?
 *   node scripts/mcp.mjs tools              # what can I call?
 *   node scripts/mcp.mjs describe <tool>    # what arguments does it take?
 *   node scripts/mcp.mjs call <tool> '{"a":1}'
 *   node scripts/mcp.mjs script probe.py    # pipe a file into any code-execution tool
 *   node scripts/mcp.mjs recipe <name> spec.json   # bundled multi-step workflow
 *   node scripts/mcp.mjs add <id> --command <exe> [--args ...]
 *   node scripts/mcp.mjs remove <id>
 *   node scripts/mcp.mjs test <id>
 *   node scripts/mcp.mjs doctor [serverId]
 *   node scripts/mcp.mjs status
 *   node scripts/mcp.mjs down
 *
 * Nothing here is specific to one product: tools are discovered from whatever
 * MCP servers are configured, and the CLI learns their argument names from
 * their schemas instead of assuming any vendor.
 *
 * No dependencies. Node 18+ (fetch/AbortSignal.timeout).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const PID_FILE = path.join(DATA_DIR, "bridge.pid");
const LOG_FILE = path.join(DATA_DIR, "bridge.log");
const SERVER_ENTRY = path.join(ROOT, "src", "server", "index.ts");
const RECIPES_DIR = path.join(ROOT, "recipes");
const DEFAULT_PORT = 7800;

// Options that never make sense as `add --args` values: seeing one after --args means the
// arguments were written without a `--` terminator.
const BRIDGE_ONLY_FLAGS = new Set(["--port", "--base", "--timeout", "--tool", "--server", "--transport", "--lines", "--help", "-h"]);

const HELP = `mcp.mjs — drive the MCP bridge from any agent

USAGE
  node scripts/mcp.mjs <command> [options]

COMMANDS
  up                     Start the bridge if it is not running, then connect every
                         enabled MCP server that is not already connected.
  down                   Stop the bridge started by this script (uses data/bridge.pid).
  status                 Bridge health, upstream health, servers, tool count.
  tools                  List callable tools as JSON.
  describe <tool>        Show one tool's description and input schema.
  call <tool> [args]     Call a tool. args is a JSON object, or "-" to read stdin.
  servers                Configured servers with transport, status and tool count.
  connect <serverId>     Connect one server (up connects every enabled one).
  add <id>               Create a server through the API, then connect it:
                         --command <exe> [--args ...] for stdio, or --url <url>.
  remove <id>            Delete a server and its stored secrets.
  test <id>              Connect, report status and tools, restore prior state.
  doctor [serverId]      Diagnose servers: resolved executable, status, tools,
                         recent log lines and hints. Works with the bridge down.
  script <file|->        Send a file to a code-execution tool. Picks the tool from
                         --tool, or the only code tool on --server.
  recipe <name> [spec]   Run recipes/<name>/kit.py through the server its
                         recipe.json names, with the spec as run(SPEC).

OPTIONS
  --port <n>             Bridge port (default ${DEFAULT_PORT}, or $PORT).
  --base <url>           Full base URL; overrides --port.
  --timeout <ms>         Per-request timeout (default 120000).
  --no-connect           With "up": do not connect servers.
  --server <id>          With "script": limit auto-detection to one server.
  --tool <name>          Exposed name (serverId__tool) or bare tool name.
  --command <exe>        With "add": executable for a stdio server.
  --args <a> [b ...]     With "add": arguments, until the next --flag.
  --                     Everything after it is a server argument, so a flag such as
                         --port 8080 can be passed: --args app.mjs -- --port 8080
  --env KEY=VALUE        With "add": environment entry (repeatable; plain config,
                         keep tokens in the panel instead).
  --url <url>            With "add": remote Streamable HTTP endpoint.
  --header KEY=VALUE     With "add": HTTP header (repeatable).
  --name <text>          With "add": display name (defaults to the id).
  --description <text>   With "add": description.
  --lines <n>            With "doctor": log lines to show (default 20).
  --help                 This text.

EXIT CODES
  0 success   1 failure (error JSON on stdout)   2 usage error

EXAMPLES
  node scripts/mcp.mjs up
  node scripts/mcp.mjs servers
  node scripts/mcp.mjs tools | jq -r '.[].exposedName'
  node scripts/mcp.mjs describe <exposedName>
  node scripts/mcp.mjs script ./probe.py --server <serverId>
  node scripts/mcp.mjs recipe <name> <spec.json>
`;

function fail(message, code = 1, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(code);
}

function note(message) {
  process.stderr.write(`[mcp] ${message}\n`);
}

// ---------------------------------------------------------------- schema-aware arguments
// Tools generated from JSON Schema often set additionalProperties: false, so an argument
// the tool never declared fails on the server ("unknown fields"). Drop undeclared keys
// locally instead and report what was dropped.
function schemaArgs(schema, args) {
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const properties =
    schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : null;
  if (!properties) return { args: source, dropped: [] };
  const allowExtra = schema.additionalProperties !== false;
  const kept = {};
  const dropped = [];
  for (const [key, value] of Object.entries(source)) {
    if (allowExtra || Object.prototype.hasOwnProperty.call(properties, key)) kept[key] = value;
    else dropped.push(key);
  }
  return { args: kept, dropped };
}

// The payload for a code-execution tool: the code field its schema names, plus a timeout
// only when the tool declares one. `timeout` is not a universal MCP argument.
function codeArguments(entry, code, opts) {
  const args = { [codeField(entry.inputSchema)]: code };
  const properties = entry.inputSchema?.properties && typeof entry.inputSchema.properties === "object"
    ? entry.inputSchema.properties
    : {};
  if (Object.prototype.hasOwnProperty.call(properties, "timeout")) {
    args.timeout = Math.min(Math.floor(opts.timeout / 1000), 60);
  }
  const filtered = schemaArgs(entry.inputSchema, args);
  if (filtered.dropped.length) note(`dropping undeclared argument(s): ${filtered.dropped.join(", ")}`);
  return filtered.args;
}

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PORT) || DEFAULT_PORT,
    base: null,
    timeout: 120000,
    connect: true,
    tool: null,
    server: null,
    args: [],
    env: [],
    header: [],
    cmd: null,
    url: null,
    name: null,
    description: null,
    transport: null,
    lines: 20,
  };
  const positional = [];
  // Everything after a bare `--` is a literal server argument, so a flag such as
  // `--port 8080` reaches the server instead of being read as a CLI option.
  let literalArgs = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (literalArgs) {
      opts.args.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--") literalArgs = true;
    else if (arg === "--port") opts.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (arg === "--base") opts.base = argv[++i];
    else if (arg === "--timeout") opts.timeout = Number(argv[++i]) || 120000;
    else if (arg === "--no-connect") opts.connect = false;
    else if (arg === "--tool") opts.tool = argv[++i];
    else if (arg === "--server") opts.server = argv[++i];
    else if (arg === "--command") opts.cmd = argv[++i];
    else if (arg === "--url") opts.url = argv[++i];
    else if (arg === "--name") opts.name = argv[++i];
    else if (arg === "--description") opts.description = argv[++i];
    else if (arg === "--transport") opts.transport = argv[++i];
    else if (arg === "--lines") opts.lines = Number(argv[++i]) || 20;
    else if (arg === "--args") {
      const before = opts.args.length;
      while (i + 1 < argv.length) {
        const next = argv[i + 1];
        if (next === "--") {
          i += 1;
          literalArgs = true;
          break;
        }
        if (next.startsWith("--")) {
          if (BRIDGE_ONLY_FLAGS.has(next)) {
            fail(
              `"${next}" would be read as a bridge option, not a server argument; put server arguments after a -- terminator: --args <value> -- ${next} ...`,
              2,
            );
          }
          break;
        }
        opts.args.push(argv[++i]);
      }
      if (opts.args.length === before && !literalArgs) {
        fail("--args needs at least one value; for arguments that start with -- write --args -- <flags...>", 2);
      }
    } else if (arg === "--env") opts.env.push(argv[++i]);
    else if (arg === "--header") opts.header.push(argv[++i]);
    else if (arg.startsWith("-") && arg !== "-") fail(`Unknown option: ${arg}`, 2);
    else positional.push(arg);
  }
  opts.command = positional[0] ?? (opts.help ? "help" : null);
  opts.rest = positional.slice(1);
  opts.baseUrl = (opts.base ?? `http://127.0.0.1:${opts.port}`).replace(/\/$/, "");
  return opts;
}

async function request(opts, method, route, body) {
  const url = `${opts.baseUrl}${route}`;
  const init = { method, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(opts.timeout) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(url, init);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const detail = payload?.error;
    throw new Error(detail ? `${detail.code}: ${detail.message}` : `HTTP ${response.status}`);
  }
  return payload;
}

async function probe(opts) {
  try {
    const state = await request(opts, "GET", "/api/state");
    return state;
  } catch {
    return null;
  }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startBridge(opts) {
  const existing = await probe(opts);
  if (existing) return { state: existing, started: false, pid: readPid() };

  if (!fs.existsSync(SERVER_ENTRY)) fail(`Bridge entrypoint missing: ${SERVER_ENTRY}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fd = fs.openSync(LOG_FILE, "a");
  fs.writeSync(fd, `\n=== mcp.mjs up ${new Date().toISOString()} ===\n`);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, PORT: String(opts.port) },
  });
  child.unref();
  fs.closeSync(fd);
  if (!child.pid) fail("Could not spawn the bridge process");
  fs.writeFileSync(PID_FILE, String(child.pid));
  note(`starting bridge (pid ${child.pid}) on port ${opts.port}`);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const state = await probe(opts);
    if (state) return { state, started: true, pid: child.pid };
    if (!isRunning(child.pid)) break;
  }
  const tail = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8").slice(-800) : "";
  fail("Bridge did not become ready within 30s", 1, { logFile: LOG_FILE, logTail: tail });
}

function serverSummary(state) {
  return (state.servers ?? []).map((server) => ({
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    status: server.runtime?.status ?? "unknown",
    tools: server.runtime?.toolCount ?? 0,
    pid: server.runtime?.pid ?? null,
    lastError: server.runtime?.lastError ?? null,
  }));
}

async function commandUp(opts) {
  const { state, started, pid } = await startBridge(opts);
  const connected = [];
  if (opts.connect) {
    for (const server of state.servers ?? []) {
      if (!server.enabled) continue;
      if (server.runtime?.status === "connected") continue;
      try {
        note(`connecting ${server.id}`);
        const result = await request(opts, "POST", `/api/servers/${encodeURIComponent(server.id)}/connect`);
        connected.push({ id: server.id, status: result?.runtime?.status ?? "unknown", tools: result?.runtime?.toolCount ?? 0 });
      } catch (error) {
        connected.push({ id: server.id, status: "failed", error: error.message });
      }
    }
  }
  const after = (await probe(opts)) ?? state;
  console.log(
    JSON.stringify(
      {
        ok: true,
        started,
        pid,
        baseUrl: opts.baseUrl,
        panel: `${opts.baseUrl}/`,
        openaiBaseUrl: `${opts.baseUrl}/v1`,
        upstream: { reachable: after.upstream?.reachable ?? false, baseUrl: after.upstream?.baseUrl, error: after.upstream?.error ?? null },
        connected,
        servers: serverSummary(after),
        tools: (after.catalog ?? []).length,
        logFile: LOG_FILE,
      },
      null,
      2,
    ),
  );
}

async function commandDown(opts) {
  const state = await probe(opts);
  const pid = readPid();
  if (!state) {
    if (pid) fs.rmSync(PID_FILE, { force: true });
    console.log(JSON.stringify({ ok: true, wasRunning: false, message: "bridge was not running" }, null, 2));
    return;
  }
  if (!pid || !isRunning(pid)) {
    fail(`Bridge is running at ${opts.baseUrl} but was not started by this script (no usable pid file). Stop it yourself.`, 1, {
      pidFile: PID_FILE,
    });
  }
  const killed = process.platform === "win32" ? spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]) : spawnSync("kill", ["-TERM", String(pid)]);
  fs.rmSync(PID_FILE, { force: true });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await probe(opts))) {
      console.log(JSON.stringify({ ok: true, wasRunning: true, stoppedPid: pid }, null, 2));
      return;
    }
  }
  fail("Bridge did not stop within 15s", 1, { pid, signal: killed.status });
}

async function commandStatus(opts) {
  const state = await probe(opts);
  if (!state) fail(`Bridge is not reachable at ${opts.baseUrl}. Run: node scripts/mcp.mjs up`, 1, { baseUrl: opts.baseUrl });
  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: opts.baseUrl,
        panel: `${opts.baseUrl}/`,
        openaiBaseUrl: `${opts.baseUrl}/v1`,
        upstream: { reachable: state.upstream?.reachable ?? false, baseUrl: state.upstream?.baseUrl, error: state.upstream?.error ?? null },
        bridge: state.bridge ?? null,
        servers: serverSummary(state),
        tools: (state.catalog ?? []).length,
        pendingApprovals: (state.approvals ?? []).length,
      },
      null,
      2,
    ),
  );
}

async function loadCatalog(opts) {
  const state = await probe(opts);
  if (!state) fail(`Bridge is not reachable at ${opts.baseUrl}. Run: node scripts/mcp.mjs up`, 1, { baseUrl: opts.baseUrl });
  return state;
}

async function commandTools(opts) {
  const state = await loadCatalog(opts);
  const tools = (state.catalog ?? []).map((entry) => ({
    exposedName: entry.exposedName,
    server: entry.serverName,
    permission: entry.permission,
    enabled: entry.enabled,
    description: entry.description,
  }));
  console.log(JSON.stringify(tools, null, 2));
  if (!tools.length) note("No tools: connect a server first (node scripts/mcp.mjs up).");
}

async function commandDescribe(opts) {
  const name = opts.rest[0];
  if (!name) fail("Usage: node scripts/mcp.mjs describe <tool>", 2);
  const state = await loadCatalog(opts);
  const entry = (state.catalog ?? []).find((item) => item.exposedName === name || item.toolName === name);
  if (!entry) fail(`Unknown tool: ${name}`, 1, { tools: (state.catalog ?? []).map((item) => item.exposedName) });
  console.log(
    JSON.stringify(
      {
        exposedName: entry.exposedName,
        server: entry.serverName,
        toolName: entry.toolName,
        permission: entry.permission,
        enabled: entry.enabled,
        description: entry.description,
        inputSchema: entry.inputSchema,
      },
      null,
      2,
    ),
  );
}

function readArgs(opts) {
  const raw = opts.rest[1];
  if (raw === undefined) return {};
  if (raw === "-") {
    const stdin = fs.readFileSync(0, "utf8").trim();
    return stdin ? JSON.parse(stdin) : {};
  }
  return JSON.parse(raw);
}

// MCP servers return tool output as text content; unwrap it when it is JSON so
// agents get a real object instead of having to parse a string twice.
function unwrap(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// Image blocks (screenshots, scene captures) arrive as data URLs. Write them next
// to the project so the caller gets files it can open, not base64 in a terminal.
function saveImages(name, payload) {
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!images.length) return [];
  const dir = path.join(DATA_DIR, "images");
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  images.forEach((image, index) => {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(image?.dataUrl ?? "");
    if (!match) return;
    const ext = match[1].split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    const file = path.join(dir, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}-${index + 1}.${ext}`);
    fs.writeFileSync(file, Buffer.from(match[2], "base64"));
    saved.push(file);
  });
  return saved;
}

async function callTool(opts, name, args) {
  const payload = await request(opts, "POST", `/api/tools/${encodeURIComponent(name)}/call`, args);
  const result = payload.result;
  const images = saveImages(name, payload);
  console.log(
    JSON.stringify(
      {
        ok: !payload.isError,
        tool: payload.tool,
        server: payload.serverId,
        durationMs: payload.durationMs,
        isError: Boolean(payload.isError),
        // The server was idle-stopped and the bridge reconnected it to run this call.
        ...(payload.reconnected ? { reconnected: true } : {}),
        result: unwrap(result),
        ...(images.length ? { images } : {}),
        // Tools such as run_script also capture stdout; keep it visible.
        ...(result && typeof result === "object" && result.output !== undefined ? { output: unwrap(result.output) } : {}),
      },
      null,
      2,
    ),
  );
  if (payload.isError) process.exitCode = 1;
  return payload;
}

async function commandCall(opts) {
  const name = opts.rest[0];
  if (!name) fail("Usage: node scripts/mcp.mjs call <tool> ['{\"arg\":1}' | -]", 2);
  let args;
  try {
    args = readArgs(opts);
  } catch (error) {
    fail(`Arguments must be a JSON object: ${error.message}`, 2);
  }
  const entry = await resolveTool(opts, name);
  const filtered = schemaArgs(entry.inputSchema, args);
  if (filtered.dropped.length) note(`dropping argument(s) the tool does not declare: ${filtered.dropped.join(", ")}`);
  await callTool(opts, entry.exposedName, filtered.args);
}

// Code tools name their payload differently (script, code, source, command…).
// Read it from the tool's own schema instead of assuming a vendor's convention.
function codeField(schema) {
  const properties = schema?.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [];
  for (const key of ["script", "code", "source", "python", "lua", "command", "input"]) {
    if (properties.includes(key)) return key;
  }
  return "script";
}

async function resolveTool(opts, raw) {
  const state = await loadCatalog(opts);
  const catalog = state.catalog ?? [];
  const exact = catalog.find((entry) => entry.exposedName === raw);
  if (exact) return exact;
  const matches = catalog.filter((entry) => entry.toolName === raw || entry.exposedName.endsWith(`__${raw}`));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail(`Tool "${raw}" exists on several servers; use its exposed name`, 1, {
      candidates: matches.map((entry) => entry.exposedName),
    });
  }
  fail(`Unknown tool: ${raw}`, 1, {
    hint: "node scripts/mcp.mjs tools lists every exposed name",
    tools: catalog.map((entry) => entry.exposedName).slice(0, 60),
  });
  return null;
}

async function autoTool(opts) {
  const state = await loadCatalog(opts);
  const pool = (state.catalog ?? []).filter((entry) => !opts.server || entry.serverId === opts.server);
  const codeTools = pool.filter((entry) => /(run[_-]?script|execute|run[_-]?python|python|eval|shell|exec)/i.test(entry.toolName));
  if (codeTools.length === 1) return codeTools[0];
  if (codeTools.length > 1) {
    fail("Several code-execution tools match; pass --tool <exposedName>", 1, {
      candidates: codeTools.map((entry) => entry.exposedName),
    });
  }
  fail("No code-execution tool found; pass --tool <exposedName>", 1, {
    tools: pool.map((entry) => entry.exposedName),
  });
  return null;
}

async function commandScript(opts) {
  const target = opts.rest[0];
  if (!target) fail("Usage: node scripts/mcp.mjs script <file|-> [--tool <name>] [--server <id>]", 2);
  let code;
  try {
    code = target === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(process.cwd(), target), "utf8");
  } catch (error) {
    fail(`Cannot read script: ${error.message}`, 2);
  }
  if (!code.trim()) fail("Script is empty", 2);
  const entry = opts.tool ? await resolveTool(opts, opts.tool) : await autoTool(opts);
  await callTool(opts, entry.exposedName, codeArguments(entry, code, opts));
}

async function commandServers(opts) {
  const state = await loadCatalog(opts);
  const servers = (state.servers ?? []).map((server) => ({
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    status: server.runtime?.status ?? "stopped",
    tools: server.runtime?.toolCount ?? 0,
    lastError: server.runtime?.lastError ?? null,
  }));
  console.log(JSON.stringify(servers, null, 2));
  if (!servers.length) note("No servers yet: add one in the panel, POST /api/servers, or copy from servers.example.json.");
}

async function commandConnect(opts) {
  const id = opts.rest[0];
  if (!id) fail("Usage: node scripts/mcp.mjs connect <serverId>", 2);
  const result = await request(opts, "POST", `/api/servers/${encodeURIComponent(id)}/connect`);
  console.log(
    JSON.stringify({ ok: true, id, status: result?.runtime?.status ?? "unknown", tools: result?.runtime?.toolCount ?? 0 }, null, 2),
  );
}

// Replace ${key} in step arguments with values from the spec JSON.
function substitute(value, spec) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(spec, key) ? String(spec[key]) : match,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, spec));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = substitute(entry, spec);
    return out;
  }
  return value;
}

// A recipe is any folder under recipes/ with a recipe.json. It either:
//   * lists `steps` — plain tool calls, for servers with no code tool, or
//   * names a `tool` plus a Python kit exporting run(SPEC), for scripted work.
async function commandRecipe(opts) {
  const name = opts.rest[0];
  if (!name) fail("Usage: node scripts/mcp.mjs recipe <name> [spec.json|-]", 2);
  const dir = path.join(RECIPES_DIR, name);
  const manifestPath = path.join(dir, "recipe.json");
  if (!fs.existsSync(manifestPath)) {
    const available = fs.existsSync(RECIPES_DIR)
      ? fs.readdirSync(RECIPES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : [];
    fail(`Unknown recipe: ${name}`, 2, { available });
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`recipes/${name}/recipe.json is not valid JSON: ${error.message}`, 1);
  }
  // Read the spec once: kit mode embeds it, step mode substitutes ${key}.
  const specPath = opts.rest[1];
  let specRaw = null;
  let spec = {};
  if (specPath) {
    try {
      specRaw = specPath === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(process.cwd(), specPath), "utf8");
    } catch (error) {
      fail(`Cannot read spec: ${error.message}`, 2);
    }
    try {
      spec = JSON.parse(specRaw) ?? {};
    } catch (error) {
      fail(`Spec must be JSON: ${error.message}`, 2);
    }
  }

  if (Array.isArray(manifest.steps)) {
    if (!manifest.steps.length) fail(`recipes/${name}/recipe.json has no steps`, 1);
    // Resolve every placeholder before touching a server, so a missing spec value is
    // reported as such instead of as a confusing tool error.
    const prepared = manifest.steps.map((step) => ({ step, args: substitute(step.args ?? {}, spec) }));
    const missing = [
      ...new Set(
        prepared.flatMap(({ args }) =>
          [...JSON.stringify(args).matchAll(/\$\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]),
        ),
      ),
    ];
    if (missing.length) {
      fail(`Recipe ${name} needs spec value(s): ${missing.join(", ")}`, 2, {
        hint: "pass a spec file: node scripts/mcp.mjs recipe <name> <spec.json>",
      });
    }

    const steps = [];
    for (const { step, args } of prepared) {
      const entry = await resolveTool(opts, step.tool);
      const payload = await request(opts, "POST", `/api/tools/${encodeURIComponent(entry.exposedName)}/call`, args);
      const stepResult = {
        step: step.name ?? entry.toolName,
        tool: entry.exposedName,
        ok: !payload.isError,
        durationMs: payload.durationMs ?? null,
        result: unwrap(payload.result),
      };
      steps.push(stepResult);
      if (!stepResult.ok && step.continueOnError !== true) break;
    }
    const ok = steps.length > 0 && steps.every((step) => step.ok);
    console.log(JSON.stringify({ ok, mode: "steps", recipe: name, steps }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  if (!manifest.tool) fail(`recipes/${name}/recipe.json needs a "tool" or "steps"`, 1);
  const kitPath = path.join(dir, manifest.kit ?? "kit.py");
  if (!fs.existsSync(kitPath)) fail(`Recipe ${name} is missing ${path.basename(kitPath)}`, 1);
  let code = fs.readFileSync(kitPath, "utf8");
  code += specRaw ? `\nSPEC = json.loads(${JSON.stringify(specRaw)})\nresult = run(SPEC)\n` : "\nresult = run()\n";
  const entry = await resolveTool(opts, manifest.tool);
  const payload = await callTool(opts, entry.exposedName, codeArguments(entry, code, opts));
  // A recipe that ran but did not verify its own work is a failure.
  const body = unwrap(payload?.result);
  const outcome = body && typeof body === "object" ? (body.result ?? body) : null;
  if (outcome && outcome.ok === false) process.exitCode = 1;
}

// ---------------------------------------------------------------- add / remove / test / doctor
async function fetchServer(opts, id) {
  const payload = await request(opts, "GET", `/api/servers/${encodeURIComponent(id)}`);
  return payload?.server ?? null;
}

function readServersFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "servers.json"), "utf8"));
  } catch {
    return null;
  }
}

function parsePairs(list = []) {
  const out = {};
  for (const item of list) {
    const at = String(item).indexOf("=");
    if (at <= 0) fail(`Expected KEY=VALUE, got: ${item}`, 2);
    out[String(item).slice(0, at)] = String(item).slice(at + 1);
  }
  return out;
}

async function commandAdd(opts) {
  const id = opts.rest[0];
  if (!id) fail("Usage: node scripts/mcp.mjs add <id> --command <exe> [--args ...] | --url <url>", 2);
  const transport = opts.url ? "streamable_http" : (opts.transport ?? "stdio");
  if (transport !== "stdio" && transport !== "streamable_http") {
    fail(`Unknown transport: ${transport}; use stdio or streamable_http`, 2);
  }

  const body = {
    id,
    name: opts.name ?? id,
    description: opts.description ?? "",
    transport,
    enabled: true,
  };
  if (transport === "stdio") {
    if (!opts.cmd) fail("add <id> needs --command <executable> (or --url for a remote server)", 2);
    body.connection = { command: opts.cmd, args: opts.args, env: parsePairs(opts.env) };
  } else {
    if (!opts.url) fail("The streamable_http transport needs --url", 2);
    body.connection = { url: opts.url, headers: parsePairs(opts.header) };
  }

  let created;
  try {
    created = await request(opts, "POST", "/api/servers", body);
  } catch (error) {
    if (/DUPLICATE/i.test(error.message)) {
      fail(`${error.message}. Remove it first: node scripts/mcp.mjs remove ${id}`, 1, { id, existing: true });
    }
    throw error;
  }

  const server = created?.server ?? null;
  const out = {
    ok: true,
    created: true,
    id: server?.id ?? id,
    transport,
    connection: transport === "stdio" ? { command: opts.cmd, args: opts.args } : { url: opts.url },
    status: server?.runtime?.status ?? "disconnected",
    tools: server?.runtime?.toolCount ?? 0,
  };

  if (opts.connect) {
    try {
      note(`connecting ${out.id}`);
      await request(opts, "POST", `/api/servers/${encodeURIComponent(out.id)}/connect`);
      const after = await fetchServer(opts, out.id);
      out.status = after?.runtime?.status ?? "unknown";
      out.tools = after?.runtime?.toolCount ?? 0;
      out.resolvedCommand = after?.runtime?.resolvedCommand ?? null;
      out.lastError = after?.runtime?.lastError ?? null;
    } catch (error) {
      out.status = "failed";
      out.error = error.message;
    }
  }

  console.log(JSON.stringify(out, null, 2));
  if (out.status === "failed") process.exitCode = 1;
}

async function commandRemove(opts) {
  const id = opts.rest[0];
  if (!id) fail("Usage: node scripts/mcp.mjs remove <id>", 2);
  const result = await request(opts, "DELETE", `/api/servers/${encodeURIComponent(id)}`);
  console.log(JSON.stringify({ ok: true, removed: true, id: result?.id ?? id }, null, 2));
}

async function commandTest(opts) {
  const id = opts.rest[0];
  if (!id) fail("Usage: node scripts/mcp.mjs test <id>", 2);
  const result = await request(opts, "POST", `/api/servers/${encodeURIComponent(id)}/test`);
  // The API connects, reports, then restores the previous state.
  const after = await fetchServer(opts, id).catch(() => null);
  const out = {
    ok: result?.ok !== false,
    id,
    status: result?.status ?? "unknown",
    tools: result?.tools ?? 0,
    resolvedCommand: after?.runtime?.resolvedCommand ?? null,
    lastError: after?.runtime?.lastError ?? null,
    restoredStatus: after?.runtime?.status ?? null,
  };
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exitCode = 1;
}

function isAbsolutePath(value) {
  return /^[A-Za-z]:|^\\\\|^\//.test(String(value ?? ""));
}

// The runtime records the executable it launched; older bridges only logged it.
function logResolvedCommand(logs) {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const message = String(logs[i]?.message ?? "");
    const match = /^launching:\s+(?:"([^"]+)"|(\S+))/.exec(message);
    if (match) return match[1] ?? match[2];
  }
  return null;
}

function describeServer(view, opts, offline = false) {
  const runtime = view.runtime ?? {};
  const connection = view.connection ?? {};
  const logs = Array.isArray(view.logs) ? view.logs : [];
  const status = runtime.status ?? "unknown";
  const hints = [];
  const entry = {
    id: view.id,
    name: view.name,
    enabled: view.enabled !== false,
    transport: view.transport ?? "stdio",
    status,
    pid: runtime.pid ?? null,
    connectedAt: runtime.connectedAt ?? null,
    lastError: runtime.lastError ?? null,
    tools: {
      count: runtime.toolCount ?? 0,
      enabled: runtime.enabledToolCount ?? null,
      names: (runtime.tools ?? []).map((tool) => tool.exposedName ?? tool.name),
    },
    calls: runtime.calls ?? 0,
    logs: logs.slice(-opts.lines).map((line) => `${line.level ?? "info"}: ${line.message ?? ""}`),
    hints,
  };

  if ((view.transport ?? "stdio") === "stdio") {
    const configured = connection.command ?? null;
    const resolved = runtime.resolvedCommand ?? logResolvedCommand(logs);
    let exists = null;
    if (resolved) {
      try {
        exists = fs.existsSync(resolved);
      } catch {
        exists = null;
      }
    }
    entry.command = {
      configured,
      args: connection.args ?? [],
      cwd: connection.cwd || null,
      envKeys: Object.keys(connection.env ?? {}),
      secretEnv: connection.secretEnv ?? [],
      resolved,
      exists,
      resolvedViaPath: Boolean(configured) && !isAbsolutePath(configured),
    };
    if (configured && !isAbsolutePath(configured)) {
      hints.push(
        `command "${configured}" comes from PATH${resolved ? ` and resolved to ${resolved}` : ""}; pin an absolute path so another project's launcher (a .uv/ or node_modules/.bin copy) cannot silently take over`,
      );
    }
    if (resolved && exists === false) hints.push(`resolved executable no longer exists: ${resolved}`);
    if (!resolved && status === "connected") hints.push("no launch path recorded yet; restart the server to record it");
  } else {
    entry.endpoint = {
      url: connection.url ?? null,
      headerKeys: Object.keys(connection.headers ?? {}),
      verifyTls: connection.verifyTls !== false,
      hasToken: connection.hasToken === true,
    };
  }

  if (!entry.enabled) hints.push("server is disabled: enable it before connecting");
  if (status === "error") {
    const last = String(runtime.lastError ?? "");
    if (/ENOENT|not recognized|not found|cannot find/i.test(last)) {
      hints.push("the executable was not found or would not start; use an absolute --command path");
    } else if (/timeout|timed out/i.test(last)) {
      hints.push("handshake timed out; raise startupTimeoutMs (120000 suits slow launchers such as uvx/npx)");
    } else if (last) {
      hints.push("connect failed; read the log lines above");
    }
  }
  if (status === "connected" && (runtime.toolCount ?? 0) === 0) hints.push("connected but advertised no tools");
  if (status === "disconnected" && entry.enabled) hints.push(`not connected: node scripts/mcp.mjs connect ${view.id}`);
  if (offline) hints.push("bridge not reachable: configuration only, no live status");
  return entry;
}

async function commandDoctor(opts) {
  const target = opts.rest[0] ?? null;
  const state = await probe(opts);
  const disk = readServersFile();
  const report = { ok: true, baseUrl: opts.baseUrl, bridge: null, servers: [] };

  if (state) {
    report.bridge = {
      reachable: true,
      pid: readPid(),
      panel: `${opts.baseUrl}/`,
      tools: (state.catalog ?? []).length,
      upstream: { reachable: state.upstream?.reachable ?? false, baseUrl: state.upstream?.baseUrl ?? null },
    };
  } else {
    report.bridge = {
      reachable: false,
      hint: "start it: node scripts/mcp.mjs up",
      configFile: path.join(DATA_DIR, "servers.json"),
    };
  }

  const ids = target
    ? [target]
    : (state ? state.servers ?? [] : disk?.servers ?? []).map((server) => server.id);
  if (!ids.length) {
    report.hint = "no servers configured: node scripts/mcp.mjs add <id> --command <exe> --args <...>";
  }

  for (const id of ids) {
    if (state) {
      try {
        const view = await fetchServer(opts, id);
        if (!view) throw new Error(`Unknown server: ${id}`);
        report.servers.push(describeServer(view, opts));
      } catch (error) {
        report.servers.push({ id, ok: false, error: error.message });
      }
      continue;
    }
    const config = (disk?.servers ?? []).find((server) => server.id === id);
    if (!config) {
      report.servers.push({ id, ok: false, error: `Unknown server: ${id}` });
      continue;
    }
    report.servers.push(describeServer({ ...config, runtime: {}, logs: [] }, opts, true));
  }

  const problems = report.servers.filter(
    (server) => server.error || server.status === "error" || (server.command && server.command.exists === false),
  );
  report.ok = Boolean(state) && problems.length === 0;
  if (!report.ok) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
}

// Positional arity per command: anything beyond it was not consumed by anyone.
const ARITY = {
  up: 0, down: 0, status: 0, tools: 0, servers: 0, help: 0,
  add: 1, remove: 1, test: 1, connect: 1, describe: 1, script: 1, doctor: 1,
  call: 2, recipe: 2,
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const allowed = ARITY[opts.command];
  if (allowed !== undefined && opts.rest.length > allowed) {
    const extra = opts.rest.slice(allowed).join(" ");
    fail(
      `Unexpected argument(s): ${extra}`,
      2,
      opts.command === "add"
        ? { command: "add", hint: "add takes one id; pass server arguments with --args <a> [b ...] and flags after --" }
        : { command: opts.command, usage: `node scripts/mcp.mjs ${opts.command}` },
    );
  }
  if (opts.args.length && opts.command !== "add") {
    fail(`--args only applies to add, not ${opts.command}`, 2, { command: opts.command });
  }
  switch (opts.command) {
    case "help":
      process.stdout.write(HELP);
      return;
    case "up":
      return commandUp(opts);
    case "down":
      return commandDown(opts);
    case "status":
      return commandStatus(opts);
    case "tools":
      return commandTools(opts);
    case "describe":
      return commandDescribe(opts);
    case "call":
      return commandCall(opts);
    case "script":
      return commandScript(opts);
    case "servers":
      return commandServers(opts);
    case "connect":
      return commandConnect(opts);
    case "recipe":
      return commandRecipe(opts);
    case "add":
      return commandAdd(opts);
    case "remove":
      return commandRemove(opts);
    case "test":
      return commandTest(opts);
    case "doctor":
      return commandDoctor(opts);
    default:
      process.stderr.write(HELP);
      fail(opts.command ? `Unknown command: ${opts.command}` : "No command given", 2);
  }
}

main().catch((error) => fail(error?.message ?? String(error)));
