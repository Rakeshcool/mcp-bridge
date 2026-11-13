# Driving the MCP servers from an AI agent

This file is for an AI (or a human wiring an AI up). It explains how to start this project's bridge and
call its MCP tools directly, with no model and no `llama-server` in the loop.

Everything goes through one script: **`scripts/mcp.mjs`**. It has no dependencies, needs only Node 18+, and
prints exactly one JSON document on stdout per command (progress notes go to stderr).

---

## 1. Start it

```bash
node scripts/mcp.mjs up
```

That is idempotent: if the bridge is already listening it reuses it; otherwise it starts
`src/server/index.ts` detached, waits for readiness (30 s cap), writes `data/bridge.pid`, logs to
`data/bridge.log`, and then connects every **enabled** MCP server that is not already connected
(pass `--no-connect` to skip that).

Output includes everything needed to continue:

```json
{
  "ok": true,
  "started": true,
  "pid": 24188,
  "panel": "http://127.0.0.1:7800/",
  "openaiBaseUrl": "http://127.0.0.1:7800/v1",
  "upstream": { "reachable": false, "error": "not reachable at http://127.0.0.1:8080" },
  "connected": [{ "id": "filesystem", "status": "connected", "tools": 16 }],
  "servers": [{ "id": "filesystem", "status": "connected", "tools": 16 }],
  "tools": 16
}
```

`upstream.reachable: false` is normal and harmless: it only means `llama-server` is not running. Direct
tool calls do not need it.

## 2. Find out what you can call

```bash
node scripts/mcp.mjs tools
```

```json
[{ "exposedName": "filesystem__list_directory", "server": "Filesystem",
   "permission": "allow", "enabled": true, "description": "List the contents of a directory…" }]
```

Tool names are namespaced `serverId__toolName`. Then get the argument schema:

```bash
node scripts/mcp.mjs describe filesystem__read_file
```

```json
{ "exposedName": "filesystem__read_file",
  "inputSchema": { "type": "object",
                   "properties": { "path": { "type": "string" }, "head": { "type": "integer" } },
                   "required": ["path"] } }
```

## 3. Call a tool

```bash
node scripts/mcp.mjs servers                                # what is configured?
node scripts/mcp.mjs call <serverId>__<toolName>
node scripts/mcp.mjs call <serverId>__<toolName> '{"arg":1}'
echo '{"arg":1}' | node scripts/mcp.mjs call <serverId>__<toolName> -
```

There is no vendor-specific tool name in this file on purpose: the bridge works with whatever servers you
configure, and every tool is addressed as `serverId__toolName`.

Result envelope — always the same shape:

```json
{ "ok": true, "tool": "<toolName>", "server": "<serverId>",
  "durationMs": 1, "isError": false, "result": { } }
```

Exit code is `0` when the tool succeeded, `1` when it returned an error or the call failed, `2` on bad
usage. Read `isError` and `result`; `result.output` holds captured stdout for the `run_script` style tools.

### Code tools, without guessing their argument names

Code-execution tools differ per server (`run_script`, `execute`, `run_python`, …) and name their payload
differently (`script`, `code`, `source`). The CLI looks at the tool's schema and uses the right name:

```bash
node scripts/mcp.mjs script ./probe.py                      # the only code tool on the bridge
node scripts/mcp.mjs script ./probe.py --server <serverId>  # limit auto-detection to one server
node scripts/mcp.mjs script ./probe.py --tool <exposedName> # exact tool
node scripts/mcp.mjs script - < probe.py                    # stdin
```

If more than one tool matches it fails with `candidates` rather than picking one, so you never send code
to the wrong server by accident.

### Recipes: one command for a multi-step job

A recipe lives in `recipes/<name>/`: `recipe.json` names the server and tool, `kit.py` does the work and
**verifies** it, so a single call replaces a probe loop:

```bash
node scripts/mcp.mjs recipe <name> <spec.json>
```

A recipe is a `recipe.json` that either lists **steps** (plain tool calls — works with any server) or names a
code tool plus a kit. `recipes/filesystem-inventory` is the step example; the format is in
`recipes/README.md`. Failures make the command exit `1`, and a missing spec value fails with the key name
instead of sending a placeholder to the server.

## 4. Stop it

```bash
node scripts/mcp.mjs down
```

Only stops a bridge started by this script (it reads `data/bridge.pid`). If the bridge was started some
other way it refuses and tells you so, rather than killing a process it does not own.

---

## Ready-to-paste agent instructions

> You have access to a shell and a local MCP bridge.
>
> - Start or verify it: `node scripts/mcp.mjs up`. It prints JSON; check `ok` and `servers[].status`.
>   `upstream.reachable: false` is fine — that is only the local LLM and direct tool calls do not need it.
> - Discover tools: `node scripts/mcp.mjs tools` (then `describe <exposedName>` for the schema).
>   Never guess a tool name or its arguments; read them first.
> - Call a tool: `node scripts/mcp.mjs call <exposedName> '<json arguments>'`. Every result is JSON with
>   `ok`, `isError`, `durationMs`, `result`. Exit code 1 means the call failed: read `error` on stdout.
> - Tool names are `serverId__toolName`. Tools with permission `ask` or `deny` reject direct calls with
>   HTTP 403 — say so instead of retrying.
> - To send code to a code-execution tool, write a `.py`/`.js` file and use
>   `node scripts/mcp.mjs script ./file.py [--server <id> | --tool <exposedName>]`, rather than escaping
>   code into a JSON string.
> - For a repeatable multi-step job use `node scripts/mcp.mjs recipe <name> <spec.json>` when a recipe
>   exists for that server. A recipe verifies its own work and exits `1` when it could not.
> - Servers stop themselves after 5 minutes idle (`IDLE STOP (S)` = 300). If a call returns
>   `MCP_TOOL_NOT_FOUND: Unknown tool …`, run `node scripts/mcp.mjs up` again to reconnect — that is not a
>   real failure.
> - Large bulk operations can exceed the 60 s MCP tool timeout while still succeeding in the background.
>   After a timeout, re-read state instead of retrying blindly, or you will duplicate work.

---

## Notes and gotchas learned from real use

**Per-tool behaviour**

- A tool's argument names come from its schema — do not assume `script`/`code`; `describe` shows them.
- Some tools return `False` or `None` where an exception would be expected. Treat a success return as a
  claim and verify the changed state when the operation matters.

**Bridge behaviour**

- Per-tool permissions: `allow` → direct call works; `ask`/`deny` → HTTP 403 with a clear message.
- `data/servers.json` holds config, `data/secrets.json` holds secrets and is never returned by the API.
- The panel at `/` has a Chat tab (needs `llama-server`) and a **Direct tool** tab (works without it) — the
  same capability as this CLI, in a browser.

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `Bridge is not reachable at …` | not started | `node scripts/mcp.mjs up` |
| `MCP_TOOL_NOT_FOUND: Unknown tool` | server idle-stopped | `node scripts/mcp.mjs up` |
| HTTP 403 on `call` | tool is `ask`/`deny` | change the permission in the panel's Servers tab |
| `Unknown tool: x` from the CLI | name not in the catalog | `node scripts/mcp.mjs tools` for exposed names |
| `Several code-execution tools match` | auto-detection refused to guess | pass `--tool` or `--server` |
| `No servers yet` | nothing configured | add one in the panel or copy from `servers.example.json` |
| `UPSTREAM_UNREACHABLE` | only affects model chat | start `llama-server` if you want the model |
| `MCP_CONNECTION_TIMEOUT` | tool ran past 60 s | re-read state; do not blindly retry |

For the model-driven path (tool injection into `llama-server`), see `README.md`. For the CLI's own flags run
`node scripts/mcp.mjs --help`.
