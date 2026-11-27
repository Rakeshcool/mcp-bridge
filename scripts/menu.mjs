#!/usr/bin/env node
// One menu to start or stop the MCP bridge.
//   node scripts/menu.mjs            interactive menu
//   node scripts/menu.mjs start      start (same as `mcp.mjs up`)
//   node scripts/menu.mjs stop       stop  (same as `mcp.mjs down`)
//   node scripts/menu.mjs status     print status and exit
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "mcp.mjs");

const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const port = portIndex >= 0 && argv[portIndex + 1] ? argv[portIndex + 1] : "7800";
const action = argv.find((arg, index) => {
  if (arg.startsWith("-")) return false;
  if (portIndex >= 0 && index === portIndex + 1) return false;
  return ["start", "stop", "status"].includes(arg);
});

function cli(command) {
  return spawnSync(process.execPath, [CLI, command, "--port", port], { encoding: "utf8" });
}

function asJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readState() {
  const run = cli("status");
  const json = run.status === 0 ? asJson(run.stdout) : null;
  return json?.ok ? { running: true, ...json } : { running: false };
}

function banner(state) {
  const lines = ["", "  AFbridge MCP"];
  if (state.running) {
    const servers = state.servers ?? [];
    const up = servers.filter((server) => server.status === "connected").length;
    lines.push(`  running   ${state.panel}  ·  ${up}/${servers.length} servers  ·  ${state.tools} tools`);
    lines.push(`  client    ${state.openaiBaseUrl}`);
    lines.push(`  upstream  ${state.upstream?.reachable ? "reachable" : "down"}  (${state.upstream?.baseUrl ?? "?"})`);
  } else {
    lines.push(`  stopped   http://127.0.0.1:${port}/`);
  }
  lines.push("");
  return lines.join("\n");
}

function errorText(run) {
  const text = (run.stderr || run.stdout || "no output").trim();
  const parsed = asJson(text);
  return parsed?.error?.message ?? text.split("\n")[0];
}

function start() {
  const run = cli("up");
  const json = asJson(run.stdout);
  if (!json?.ok) return console.log(`  start failed: ${errorText(run)}`);
  if (json.started) console.log(`  started — ${json.panel}${json.pid ? `  (pid ${json.pid})` : ""}`);
  else console.log(`  already running — ${json.panel}`);
}

// The CLI only stops a bridge it started itself, so fall back to the process
// holding the port — but only after confirming it really is this bridge.
function listenerPid() {
  if (process.platform === "win32") {
    const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    const line = (netstat.stdout ?? "")
      .split("\n")
      .find((row) => row.includes(`:${port} `) && row.includes("LISTENING"));
    const pid = line?.trim().split(/\s+/).pop();
    return pid && /^\d+$/.test(pid) ? pid : null;
  }
  const lsof = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const pid = (lsof.stdout ?? "").trim().split("\n")[0];
  return pid && /^\d+$/.test(pid) ? pid : null;
}

function processCommand(pid) {
  if (process.platform !== "win32") {
    const ps = spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" });
    return (ps.stdout ?? "").trim();
  }
  const ps = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], {
    encoding: "utf8",
  });
  return (ps.stdout ?? "").trim();
}

function stop() {
  const run = cli("down");
  const json = asJson(run.stdout);
  if (json?.ok) {
    console.log(json.stoppedPid ? `  stopped pid ${json.stoppedPid}` : "  bridge was not running");
    return;
  }

  const pid = listenerPid();
  if (!pid) return console.log(`  stop failed: ${errorText(run)}`);
  const command = processCommand(pid);
  if (!command || !/src[\\/]server[\\/]index\.ts/.test(command)) {
    return console.log(`  port ${port} is held by pid ${pid}, which is not the bridge — left alone`);
  }
  const killed =
    process.platform === "win32"
      ? spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { encoding: "utf8" })
      : spawnSync("kill", ["-TERM", pid], { encoding: "utf8" });
  console.log(killed.status === 0 ? `  stopped pid ${pid} (was started outside the CLI)` : `  could not stop pid ${pid}: ${(killed.stderr || "").trim()}`);
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+D / piped input ending mid-prompt must exit, not leave a dangling await.
  rl.on("close", () => process.exit(0));
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  for (;;) {
    process.stdout.write(banner(readState()));
    process.stdout.write("  1) Start   2) Stop   3) Refresh   0) Quit\n");
    const answer = (await ask("  choose: ")).trim().toLowerCase();
    if (answer === "1" || answer === "s") start();
    else if (answer === "2") stop();
    else if (answer === "3" || answer === "") continue;
    else if (answer === "0" || answer === "q") break;
    else process.stdout.write("  pick 1, 2, 3 or 0\n");
  }
  rl.close();
}

if (action === "start") start();
else if (action === "stop") stop();
else if (action === "status") process.stdout.write(banner(readState()));
else await menu();
