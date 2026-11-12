#!/usr/bin/env node
/**
 * mcp.mjs — start the MCP bridge and talk to its MCP tools directly.
 *
 * Built for AI agents: every command prints one JSON document to stdout and
 * exits 0 on success, 1 on failure, 2 on bad usage. Progress notes go to stderr
 * so stdout stays parseable.
 *
 *   node scripts/mcp.mjs up                 # start the bridge (idempotent) + connect servers
 *   node scripts/mcp.mjs tools              # what can I call?
 *   node scripts/mcp.mjs describe <tool>    # what arguments does it take?
 *   node scripts/mcp.mjs call <tool> '{"a":1}'
 *   node scripts/mcp.mjs script probe.py    # python into Resolve, via the run_script tool
 *   node scripts/mcp.mjs status
 *   node scripts/mcp.mjs down
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
const DEFAULT_PORT = 7800;
const DEFAULT_SCRIPT_TOOL = "davinci-resolve__run_script";

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
  script <file|->        Run Python inside Resolve through ${DEFAULT_SCRIPT_TOOL}.

OPTIONS
  --port <n>             Bridge port (default ${DEFAULT_PORT}, or $PORT).
  --base <url>           Full base URL; overrides --port.
  --timeout <ms>         Per-request timeout (default 120000).
  --no-connect           With "up": do not connect servers.
  --tool <name>          With "script": tool to pipe the code into.
  --help                 This text.

EXIT CODES
  0 success   1 failure (error JSON on stdout)   2 usage error

EXAMPLES
  node scripts/mcp.mjs up
  node scripts/mcp.mjs tools | jq -r '.[].exposedName'
  node scripts/mcp.mjs call davinci-resolve__get_resolve_status
  node scripts/mcp.mjs call davinci-resolve__list_luts '{}'
  node scripts/mcp.mjs script ./probe.py
`;

function fail(message, code = 1, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(code);
}

function note(message) {
  process.stderr.write(`[mcp] ${message}\n`);
}

function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || DEFAULT_PORT, base: null, timeout: 120000, connect: true, tool: DEFAULT_SCRIPT_TOOL };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--port") opts.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (arg === "--base") opts.base = argv[++i];
    else if (arg === "--timeout") opts.timeout = Number(argv[++i]) || 120000;
    else if (arg === "--no-connect") opts.connect = false;
    else if (arg === "--tool") opts.tool = argv[++i];
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

async function callTool(opts, name, args) {
  const payload = await request(opts, "POST", `/api/tools/${encodeURIComponent(name)}/call`, args);
  const result = payload.result;
  console.log(
    JSON.stringify(
      {
        ok: !payload.isError,
        tool: payload.tool,
        server: payload.serverId,
        durationMs: payload.durationMs,
        isError: Boolean(payload.isError),
        result: unwrap(result),
        // Tools such as run_script also capture stdout; keep it visible.
        ...(result && typeof result === "object" && result.output !== undefined ? { output: unwrap(result.output) } : {}),
      },
      null,
      2,
    ),
  );
  if (payload.isError) process.exitCode = 1;
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
  await callTool(opts, name, args);
}

async function commandScript(opts) {
  const target = opts.rest[0];
  if (!target) fail("Usage: node scripts/mcp.mjs script <file.py|->", 2);
  let code;
  try {
    code = target === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(process.cwd(), target), "utf8");
  } catch (error) {
    fail(`Cannot read script: ${error.message}`, 2);
  }
  if (!code.trim()) fail("Script is empty", 2);
  await callTool(opts, opts.tool, { script: code, timeout: Math.min(Math.floor(opts.timeout / 1000), 60) });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
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
    default:
      process.stderr.write(HELP);
      fail(opts.command ? `Unknown command: ${opts.command}` : "No command given", 2);
  }
}

main().catch((error) => fail(error?.message ?? String(error)));
