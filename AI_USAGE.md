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
  "connected": [{ "id": "davinci-resolve", "status": "connected", "tools": 14 }],
  "servers": [{ "id": "davinci-resolve", "status": "connected", "tools": 14 }],
  "tools": 14
}
```

`upstream.reachable: false` is normal and harmless: it only means `llama-server` is not running. Direct
tool calls do not need it.

## 2. Find out what you can call

```bash
node scripts/mcp.mjs tools
```

```json
[{ "exposedName": "davinci-resolve__get_resolve_status", "server": "DaVinci Resolve",
   "permission": "allow", "enabled": true, "description": "Check whether DaVinci Resolve is running…" }]
```

Tool names are namespaced `serverId__toolName`. Then get the argument schema:

```bash
node scripts/mcp.mjs describe davinci-resolve__run_script
```

```json
{ "exposedName": "davinci-resolve__run_script",
  "inputSchema": { "type": "object",
                   "properties": { "script": { "type": "string" }, "timeout": { "type": "integer" } },
                   "required": ["script"] } }
```

## 3. Call a tool

```bash
node scripts/mcp.mjs call davinci-resolve__get_resolve_status
node scripts/mcp.mjs call davinci-resolve__list_luts '{}'
node scripts/mcp.mjs call davinci-resolve__run_script '{"script":"print(1+1)"}'
echo '{"script":"print(1+1)"}' | node scripts/mcp.mjs call davinci-resolve__run_script -
```

Result envelope — always the same shape:

```json
{ "ok": true, "tool": "get_resolve_status", "server": "davinci-resolve",
  "durationMs": 1, "isError": false, "result": { "running": true, "version": "21.1.2" } }
```

Exit code is `0` when the tool succeeded, `1` when it returned an error or the call failed, `2` on bad
usage. Read `isError` and `result`; `result.output` holds captured stdout for the `run_script` style tools.

For Resolve scripting, avoid JSON escaping entirely:

```bash
node scripts/mcp.mjs script ./probe.py      # or: node scripts/mcp.mjs script - < probe.py
```

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
> - To run Python inside DaVinci Resolve, write a `.py` file and use
>   `node scripts/mcp.mjs script ./file.py`, rather than escaping code into a JSON string.
> - Servers stop themselves after 5 minutes idle (`IDLE STOP (S)` = 300). If a call returns
>   `MCP_TOOL_NOT_FOUND: Unknown tool …`, run `node scripts/mcp.mjs up` again to reconnect — that is not a
>   real failure.
> - Large `AppendToTimeline`/bulk operations can exceed the 60 s MCP tool timeout while still succeeding in
>   the background. After a timeout, re-read state instead of retrying blindly, or you will duplicate work.

---

## Notes and gotchas learned from real use

**Resolve scripting API (the `davinci-resolve` server)**

- `proj.GetCurrentTimeline()`, then `timeline.GetItemListInTrack("video", 1)` — track indexes are 1-based.
- `timeline.DetectSceneCuts()` returns `True` immediately but works **asynchronously**; re-read the clip
  list a couple of seconds later to see the cuts.
- `AppendToTimeline` treats `endFrame` as **exclusive** in this build, contrary to the docs
  (`startFrame: s, endFrame: e` yields `e - s` frames). Always verify total frames afterwards.
- `GetEffects()` and `DeleteEffects()` are unreliable (they report empty / return `False` even when effects
  exist). `AddEffect("ofx", "Resolve FX/Resolve FX Blur/Gaussian Blur")` returns an Effect handle whose
  `GetInfo()` is trustworthy, and its `GetIndex()` is **1-based**. There is no `SplitPlayhead`, so to cut
  you rebuild the timeline from ranges.
- Effect parameters are not writable through the scripting API (only `GetInfo`, `GetIndex`, `SetIndex`,
  `GetIsEnabled`, `SetIsEnabled`).
- `proj.GetCurrentPage()` is not available; `resolve.OpenPage("edit")` is.

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
| `UPSTREAM_UNREACHABLE` | only affects model chat | start `llama-server` if you want the model |
| `MCP_CONNECTION_TIMEOUT` | tool ran past 60 s | re-read state; do not blindly retry |

For the model-driven path (tool injection into `llama-server`), see `README.md`. For the CLI's own flags run
`node scripts/mcp.mjs --help`.
