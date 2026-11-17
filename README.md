# MCP Bridge for llama.cpp

A local service that gives a plain `llama-server` access to MCP tools — and gives any AI agent a direct,
model-free way to call those same tools.

Nothing upstream is patched. The bridge sits in front of `llama.cpp`, owns the MCP servers, injects their
tools into chat requests, and runs the tool calls itself.

The bridge is **not tied to any product**: every tool is discovered from whatever MCP servers you
configure — a local executable speaking stdio, or a remote Streamable HTTP endpoint — and names are
namespaced `serverId__toolName`. Nothing in the runtime, the panel or the CLI knows about any particular
vendor, product or tool. Copy entries from [`servers.example.json`](servers.example.json) to start.

```
OpenAI client / panel ──/v1/chat/completions──►  bridge :7800  ──►  llama-server :8080
                                                   │
                                                   ├─ injects MCP tools as serverId__toolName
                                                   ├─ runs the tool-call loop (default 5 rounds)
                                                   ├─ enforces Allow / Ask / Deny per tool
                                                   └─ returns one ordinary assistant message

browser / CLI / any agent ──/api/tools/:name/call──► bridge ──► MCP server (stdio or Streamable HTTP)
                                                              (no model involved)
```

## Requirements

- **Node 18+** to run (Node 24 recommended — the server runs TypeScript directly, no backend build step).
- **Bun** optional, only for installing dependencies and the Vite build.
- **llama.cpp** with `llama-server` running — needed **only** for model chat. Direct tool calls work without it.
- Any MCP servers you want to expose: a local executable speaking stdio, or a remote Streamable HTTP endpoint.

## Quick start

```bash
bun install
bun run build      # builds the panel into dist/client
bun run start      # http://127.0.0.1:7800
```

Then either:

- open **http://127.0.0.1:7800/** and use the panel, or
- point any OpenAI-compatible client at **`http://127.0.0.1:7800/v1`** — no `tools` array needed, and
- let an agent drive the tools directly with `node scripts/mcp.mjs up` (see below).

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `7800` | Bridge port |
| `LLAMA_BASE` | `http://127.0.0.1:8080` | Upstream `llama-server` |

## Three ways in

### 1. Model chat (needs llama-server)

Point any OpenAI client at the bridge instead of at `llama-server`. The bridge injects every enabled,
connected, permitted tool as `serverId__toolName`, runs the calls the model asks for, and returns a normal
assistant message. `stream: true` returns SSE.

```bash
curl -s http://127.0.0.1:7800/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What tools do you have?"}]}'
```

### 2. Direct tool calls (no model)

`POST /api/tools/:exposedName/call` — the body is the argument object (or `{"arguments":{...}}`).

```bash
curl -s http://127.0.0.1:7800/api/tools/<serverId>__<toolName> -X POST -d '{}'
# {"ok":true,"tool":"<toolName>","serverId":"<serverId>","durationMs":1,
#  "isError":false,"result":{...}}
```

Only tools whose permission is `allow` accept direct calls; `ask` and `deny` return **403** with an
explanation, because no one is there to answer an approval prompt.

Results are text, plus images when a server returns them (screenshots, renders, captures):

```jsonc
{ "ok": true, "isError": false, "result": "[image image/png, 1128 KB]",
  "images": [{ "mimeType": "image/png", "dataUrl": "data:image/png;base64,…" }] }
```

The CLI writes those to `data/images/` and prints the file paths, so they can be opened, diffed or passed
to a vision model without hand-decoding base64.

### 3. Agent CLI

`scripts/mcp.mjs` has no dependencies and prints one JSON document per command (exit codes `0` / `1` / `2`).

```bash
node scripts/mcp.mjs up                    # start if needed, connect enabled servers
node scripts/mcp.mjs servers               # configured servers, transport, status, tools
node scripts/mcp.mjs connect <serverId>    # connect one server
node scripts/mcp.mjs tools                 # list callable tools
node scripts/mcp.mjs describe <exposedName>
node scripts/mcp.mjs call <exposedName> '{"arg":1}'
node scripts/mcp.mjs script ./probe.py --server <serverId>   # code into any code-execution tool
node scripts/mcp.mjs recipe <name> spec.json # bundled workflow (see recipes/)
node scripts/mcp.mjs status
node scripts/mcp.mjs down                  # stops only a bridge this script started
```

`call` saves any image results to `data/images/` and lists them under `images` in its JSON output.

`npm run mcp -- <command>` works too. Full contract and a paste-ready agent prompt: **[`AI_USAGE.md`](AI_USAGE.md)**.

## Recipes (optional, any server)

A **recipe** is a folder under `recipes/` with a `recipe.json`. It is either a list of **steps** (plain tool
calls, for servers with no code tool) or a **kit** (code sent to a code-execution tool) that verifies its own
work, so one command replaces a probe loop:

```bash
node scripts/mcp.mjs recipe <name> <spec.json>
```

`recipes/filesystem-inventory` is the worked example (needs a filesystem server configured). Format,
contract and kit rules: **[`recipes/README.md`](recipes/README.md)**.


## The panel

Served from the same port as the API, so there is nothing extra to run.

- **Chat** — default view. *Local model* streams replies from `llama-server` and shows every MCP tool call
  inline (name, permission, duration, arguments, result); *Direct tool* picks a tool and JSON arguments and
  calls it with no model in the loop. A banner appears when the upstream is unreachable.
- **Servers** — add, edit, connect, disconnect, restart, disable and delete MCP servers; search and filter by
  transport or status. Per-server detail has **Overview / Tools / Logs / Configuration** tabs, per-tool
  Allow/Ask/Deny, and redacted diagnostics.
- **Bridge** — upstream target, the copyable client `base_url`, bridge limits, and recent bridged requests.

## How tool calling works

- **Injection** — tools are namespaced `serverId__toolName` and merged with any `tools` the client sent;
  client-declared tools always win on name collisions.
- **Loop** — the bridge runs up to `maxRounds` (default 5) rounds of tool calls before it must answer.
- **Permissions** — `allow` runs immediately, `deny` is hidden from the model and refused for direct calls,
  `ask` raises an approval in the panel (60 s timeout, denied on timeout).
- **Lifecycle** — a server starts on first explicit Connect (never silently on boot), stops after its idle
  timeout, and restarts per policy with backoff (3 attempts).
- **Transport** — stdio servers speak NDJSON or `Content-Length` framing; HTTP servers use Streamable HTTP.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/chat/completions` | Bridged chat with MCP tools; `stream: true` returns SSE |
| ANY | `/v1/*` except chat (models, completions, embeddings…) | Proxied straight to `llama-server` |
| GET | `/props`, `/health`, `/metrics`, `/tokenize`, `/detokenize`, `/slots` | Proxied straight to `llama-server` |
| GET | `/api/state` | Servers, runtime status, bridge settings, catalog, approvals |
| POST / GET | `/api/servers` | Create / list servers |
| PUT / DELETE | `/api/servers/:id` | Update / remove |
| POST | `/api/servers/:id/{connect,disconnect,restart,test}` | Lifecycle |
| POST | `/api/servers/:id/enable` | Enable or disable |
| GET / POST | `/api/servers/:id/tools`, `/tools/refresh` | Discovery |
| GET / DELETE | `/api/servers/:id/logs` | Bounded, redacted diagnostics |
| GET | `/api/tools` · PATCH `/api/tools/:exposedName` | Catalog and permissions |
| POST | `/api/tools/:exposedName/call` | Call a tool directly — no model involved |
| GET / PUT | `/api/bridge` | Upstream settings |
| GET | `/api/activity` · `/api/events` | Request traces · SSE event stream |
| POST | `/api/approvals/:id` | Answer an `Ask` approval |

Errors are always `{"error":{"code":"MCP_…","message":"…","details":…}}`.

## Adding a server

From the panel (**Add MCP Server**) or the API:

```jsonc
// local stdio
{ "name": "Filesystem", "transport": "stdio",
  "connection": { "command": "npx",
                  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "env": {} } }

// remote Streamable HTTP
{ "name": "Remote", "transport": "streamable_http",
  "connection": { "url": "https://example.com/mcp", "headers": {}, "verifyTls": true } }
```

Secret env values, headers and bearer tokens are stored in `data/secrets.json`, never returned by the API
and never written to logs.

## Project layout

```
src/server/          bridge runtime (no framework, no MCP SDK)
  index.ts           http server + startup
  api.ts             all REST routes
  bridge.ts          tool-injection chat loop
  registry.ts        server lifecycle, catalog, tool state
  upstream.ts        llama-server client (chat, props, health)
  mcp/stdio.ts       stdio client (NDJSON + Content-Length, tree kill)
  mcp/streamable.ts  Streamable HTTP client
  config.ts secrets.ts validate.ts logs.ts activity.ts approvals.ts
src/client/          Svelte 5 panel (Chat / Servers / Bridge)
scripts/mcp.mjs      agent CLI (start, servers, tools, call, script, recipe)
recipes/             recipe format (you add the recipes)
data/                servers.json, bridge.json, secrets.json, bridge.log, images/
servers.example.json copy-paste server entries (stdio + Streamable HTTP)
AI_USAGE.md          how an AI drives it, with a paste-ready prompt
```

## Notes and limits

- Binds to `127.0.0.1` only; management routes reject foreign `Origin` and non-loopback `Host` headers.
- Streaming responses are emitted as SSE chunks after the tool rounds finish, so tokens for the final answer
  arrive once the model commits to text.
- Processes are killed with `taskkill /T /PID` on Windows and stdin-close + `SIGKILL` elsewhere.
- MCP tool calls are capped at 60 s. Bulk operations can outlive that and still finish in the background —
  re-read state rather than retrying, or you will duplicate work.
- Servers with an idle timeout stop themselves; a tool call then returns `MCP_TOOL_NOT_FOUND` until you
  Connect again.
- This app spawns local processes, so it is **not** deployable to hosted platforms.

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `UPSTREAM_UNREACHABLE` | `llama-server` down | start it; direct tool calls still work |
| `MCP_TOOL_NOT_FOUND` | owning server idle-stopped | connect it (`node scripts/mcp.mjs up`) |
| HTTP 403 on a direct call | tool is `ask`/`deny` | change the permission on the Servers tab |
| `MCP_PROCESS_EXITED` | server binary died at startup | check its Logs tab; verify the command path |
| Model stops with "maximum number of tool-call rounds" | it kept calling tools | raise max rounds under Bridge, or give exact API names |

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE).
Copyright 2026 Rakeshcool.
