# Recipes

A recipe turns a multi-step job against MCP servers into a single command with one JSON result:

```bash
node scripts/mcp.mjs recipe <name> [spec.json|-]
```

A recipe is a folder here:

```
recipes/<name>/
  recipe.json     what to run
  kit.py          only for scripted recipes: the code sent to a code-execution tool
  example.json    optional example spec
```

Two kinds of recipe, because not every server can execute code.

## 1. Steps — plain tool calls

For servers that only expose ordinary tools. The CLI calls them in order through the bridge:

```jsonc
{
  "description": "what it does",
  "steps": [
    { "name": "allowed", "tool": "filesystem__list_allowed_directories" },
    { "name": "tree", "tool": "filesystem__directory_tree", "args": { "path": "${path}" } }
  ],
  "spec": "example.json"
}
```

- `tool` is an exposed name (`serverId__toolName`) or a bare tool name that is unique across servers.
- `${key}` in an argument is replaced by `spec[key]`; unknown keys are left as-is so a missing spec value
  is visible instead of silently becoming `undefined`.
- Execution stops at the first failing step unless that step sets `"continueOnError": true`.
- Output: `{ "ok": bool, "mode": "steps", "recipe": name, "steps": [{step, tool, ok, durationMs, result}] }`,
  exit `1` if any step failed.

Worked example: `recipes/filesystem-inventory` — lists the directories a filesystem server may touch, then
prints its tree. Needs that server configured; the spec supplies `path`.

## 2. Kit — scripted, self-verifying

For servers with a code-execution tool (`run_script`, `execute`, …). The CLI appends
`SPEC = json.loads("<spec>")` and `result = run(SPEC)` to `kit.py` and sends it to the tool named in
`recipe.json`:

```jsonc
{
  "server": "my-server",
  "tool": "my-server__run_script_unsafe",
  "kit": "kit.py",
  "spec": "example.json"
}
```

- `result` must always be set, including inside exception handlers; printed output is captured too.
- The kit should verify its own writes and report `{ "ok": bool, ...evidence }` — the caller should never
  have to check twice.
- A kit reporting `{"ok": false}` makes the command exit `1`.
- Be idempotent: tag what you create and remove it at the start of the next run.

## Writing either kind

Read the tool's schema first (`node scripts/mcp.mjs describe <exposedName>`) and use its real argument
names — do not assume `script`/`code`/`path`. If a tool returns `False` or `None` where an error would be
expected, treat the return as a claim and verify the changed state in a later step.
