<script lang="ts">
  import { call } from "./api.ts";
  import type { ServerView } from "./api.ts";

  interface Props {
    server: ServerView | null;
    onclose: () => void;
    onsaved: (message: string) => void | Promise<void>;
  }

  let { server, onclose, onsaved }: Props = $props();

  const editing = server !== null;
  const conn: Record<string, any> = server?.connection ?? {};

  let name = $state(server?.name ?? "");
  let description = $state(server?.description ?? "");
  let transport = $state<"stdio" | "streamable_http">(server?.transport ?? "stdio");
  let enabled = $state(server?.enabled ?? true);
  let hidden = $state(server?.visibility === "hidden_until_mentioned");

  let command = $state<string>(String(conn.command ?? ""));
  let cwd = $state<string>(String(conn.cwd ?? ""));
  let args = $state<string[]>(Array.isArray(conn.args) ? [...conn.args] : []);
  let envRows = $state<Array<{ key: string; value: string; secret: boolean }>>([
    ...Object.entries((conn.env ?? {}) as Record<string, string>).map(([key, value]) => ({ key, value: String(value), secret: false })),
    ...(Array.isArray(conn.secretEnv) ? (conn.secretEnv as string[]) : []).map((key) => ({ key, value: "", secret: true })),
  ]);

  let url = $state<string>(String(conn.url ?? ""));
  let token = $state<string>("");
  let verifyTls = $state<boolean>(conn.verifyTls !== false);
  let headerRows = $state<Array<{ key: string; value: string; secret: boolean }>>([
    ...Object.entries((conn.headers ?? {}) as Record<string, string>).map(([key, value]) => ({ key, value: String(value), secret: false })),
    ...(Array.isArray(conn.secretHeaders) ? (conn.secretHeaders as string[]) : []).map((key) => ({ key, value: "", secret: true })),
  ]);

  let startupTimeout = $state(Math.round((server?.startupTimeoutMs ?? 30000) / 1000));
  let toolTimeout = $state(Math.round((server?.toolTimeoutMs ?? 60000) / 1000));
  let idleTimeout = $state(Math.round((server?.idleTimeoutMs ?? 0) / 1000));
  let restartPolicy = $state<"never" | "on_failure">(server?.restartPolicy ?? "on_failure");

  let saving = $state(false);
  let error = $state("");

  function collect(rows: Array<{ key: string; value: string; secret: boolean }>): { plain: Record<string, string>; secret: string[]; values: Record<string, string> } {
    const plain: Record<string, string> = {};
    const values: Record<string, string> = {};
    const secret: string[] = [];
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      if (row.secret) {
        secret.push(key);
        if (row.value) values[key] = row.value;
      } else if (row.value) {
        plain[key] = row.value;
      }
    }
    return { plain, secret, values };
  }

  async function save(): Promise<void> {
    saving = true;
    error = "";
    try {
      const env = collect(envRows);
      const headers = collect(headerRows);
      const connection: Record<string, unknown> =
        transport === "stdio"
          ? {
              command: command.trim(),
              args: args.map((arg) => arg),
              cwd: cwd.trim() || undefined,
              env: { ...env.plain, ...env.values },
              secretEnv: env.secret,
            }
          : {
              url: url.trim(),
              headers: { ...headers.plain, ...headers.values },
              secretHeaders: headers.secret,
              authType: token || conn.authType === "bearer" ? "bearer" : "none",
              token: token || undefined,
              verifyTls,
            };

      const payload = {
        name: name.trim(),
        description: description.trim(),
        enabled,
        visibility: hidden ? "hidden_until_mentioned" : "normal",
        transport,
        connection,
        startupTimeoutMs: startupTimeout * 1000,
        toolTimeoutMs: toolTimeout * 1000,
        idleTimeoutMs: idleTimeout * 1000,
        restartPolicy,
      };

      if (editing && server) await call(`/api/servers/${server.id}`, { method: "PUT", body: payload });
      else await call("/api/servers", { method: "POST", body: payload });
      await onsaved(editing ? "Server updated" : "Server added");
    } catch (caught) {
      error = (caught as Error).message;
    } finally {
      saving = false;
    }
  }

  const field = "w-full rounded-lg border border-edge bg-base px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none";
  const label = "text-[11px] uppercase tracking-wide text-dim";
</script>

<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" role="presentation">
  <div class="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-edge bg-panel shadow-2xl">
    <header class="sticky top-0 flex items-center justify-between border-b border-edge bg-panel px-5 py-3">
      <h2 class="text-sm font-semibold">{editing ? `Edit ${server?.name}` : "Add MCP Server"}</h2>
      <button class="rounded-md border border-edge px-2 py-1 text-xs text-muted hover:text-ink" onclick={onclose}>Cancel</button>
    </header>

    <div class="space-y-4 px-5 py-4">
      <div class="flex gap-1 rounded-lg border border-edge bg-panel-2 p-0.5 text-xs">
        <button
          class={transport === "stdio" ? "flex-1 rounded-md bg-edge px-3 py-1.5 text-ink" : "flex-1 rounded-md px-3 py-1.5 text-muted hover:text-ink"}
          onclick={() => (transport = "stdio")}>On this computer</button
        >
        <button
          class={transport === "streamable_http" ? "flex-1 rounded-md bg-edge px-3 py-1.5 text-ink" : "flex-1 rounded-md px-3 py-1.5 text-muted hover:text-ink"}
          onclick={() => (transport = "streamable_http")}>Web address</button
        >
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="col-span-2">
          <label class={label} for="server-name">Name</label>
          <input id="server-name" class={field} bind:value={name} placeholder="My MCP server" />
        </div>
        <div class="col-span-2">
          <label class={label} for="server-description">Description</label>
          <textarea id="server-description" class={field} rows="2" bind:value={description} placeholder="What this server exposes"></textarea>
        </div>
        <label class="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" bind:checked={enabled} /> Enabled
        </label>
        <label class="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" bind:checked={hidden} /> Hide from agent unless @mentioned
        </label>
      </div>

      {#if transport === "stdio"}
        <div class="space-y-3 rounded-lg border border-edge bg-panel-2 p-3">
          <div>
            <label class={label} for="server-command">Command</label>
            <input id="server-command" class={field} bind:value={command} placeholder="C:\path\to\server.exe or npx" />
            <p class="mt-1 text-[11px] text-dim">
              Launched directly with an argument array — never through a shell. <code class="mono">.cmd</code>/<code class="mono">.bat</code>
              use cmd.exe; <code class="mono">.exe</code> and PATH commands do not.
            </p>
          </div>
          <div>
            <div class="flex items-center justify-between">
              <span class={label}>Arguments</span>
              <button class="text-[11px] text-accent hover:underline" onclick={() => args.push("")}>add argument</button>
            </div>
            {#if args.length === 0}
              <p class="mt-1 text-[11px] text-dim">No arguments.</p>
            {/if}
            {#each args as _, index}
              <div class="mt-1 flex gap-2">
                <input class="{field} mono" bind:value={args[index]} placeholder="--flag" />
                <button class="rounded-md border border-edge px-2 text-xs text-muted hover:text-bad" onclick={() => args.splice(index, 1)}>×</button>
              </div>
            {/each}
          </div>
          <div>
            <label class={label} for="server-cwd">Working directory</label>
            <input id="server-cwd" class={field} bind:value={cwd} placeholder="optional" />
          </div>
          <div>
            <div class="flex items-center justify-between">
              <span class={label}>Environment variables</span>
              <button class="text-[11px] text-accent hover:underline" onclick={() => envRows.push({ key: "", value: "", secret: false })}>add variable</button>
            </div>
            {#each envRows as row, index}
              <div class="mt-1 flex items-center gap-2">
                <input class="{field} mono" bind:value={envRows[index].key} placeholder="KEY" />
                <input
                  class="{field} mono"
                  bind:value={envRows[index].value}
                  placeholder={row.secret ? "secret value (kept out of config)" : "value"}
                  type={row.secret ? "password" : "text"}
                />
                <label class="flex shrink-0 items-center gap-1 text-[11px] text-muted">
                  <input type="checkbox" bind:checked={envRows[index].secret} /> secret
                </label>
                <button class="rounded-md border border-edge px-2 text-xs text-muted hover:text-bad" onclick={() => envRows.splice(index, 1)}>×</button>
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <div class="space-y-3 rounded-lg border border-edge bg-panel-2 p-3">
          <div>
            <label class={label} for="server-url">Server URL</label>
            <input id="server-url" class={field} bind:value={url} placeholder="https://example.com/mcp" />
          </div>
          <div>
            <label class={label} for="server-token">Bearer token</label>
            <input id="server-token" class={field} type="password" bind:value={token} placeholder={conn.hasToken ? "stored — leave blank to keep" : "optional"} />
          </div>
          <div>
            <div class="flex items-center justify-between">
              <span class={label}>Custom headers</span>
              <button class="text-[11px] text-accent hover:underline" onclick={() => headerRows.push({ key: "", value: "", secret: false })}>add header</button>
            </div>
            {#each headerRows as row, index}
              <div class="mt-1 flex items-center gap-2">
                <input class="{field} mono" bind:value={headerRows[index].key} placeholder="X-Header" />
                <input class="{field} mono" bind:value={headerRows[index].value} placeholder={row.secret ? "secret value" : "value"} type={row.secret ? "password" : "text"} />
                <label class="flex shrink-0 items-center gap-1 text-[11px] text-muted">
                  <input type="checkbox" bind:checked={headerRows[index].secret} /> secret
                </label>
                <button class="rounded-md border border-edge px-2 text-xs text-muted hover:text-bad" onclick={() => headerRows.splice(index, 1)}>×</button>
              </div>
            {/each}
          </div>
          <label class="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={verifyTls} /> Verify TLS certificate
          </label>
        </div>
      {/if}

      <div class="grid grid-cols-3 gap-3">
        <div>
          <label class={label} for="startup-timeout">Startup timeout (s)</label>
          <input id="startup-timeout" class={field} type="number" min="1" bind:value={startupTimeout} />
        </div>
        <div>
          <label class={label} for="tool-timeout">Tool timeout (s)</label>
          <input id="tool-timeout" class={field} type="number" min="1" bind:value={toolTimeout} />
        </div>
        <div>
          <label class={label} for="idle-timeout">Idle stop (s)</label>
          <input id="idle-timeout" class={field} type="number" min="0" bind:value={idleTimeout} />
        </div>
        <div class="col-span-3">
          <label class={label} for="restart-policy">Restart policy</label>
          <select id="restart-policy" class={field} bind:value={restartPolicy}>
            <option value="on_failure">Restart on failure</option>
            <option value="never">Never restart</option>
          </select>
        </div>
      </div>

      {#if error}
        <div class="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</div>
      {/if}
    </div>

    <footer class="sticky bottom-0 flex items-center justify-between border-t border-edge bg-panel px-5 py-3">
      <p class="text-[11px] text-dim">First launch always requires an explicit Connect.</p>
      <div class="flex gap-2">
        <button class="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink" onclick={onclose}>Cancel</button>
        <button
          class="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-base hover:bg-accent-2 disabled:opacity-50"
          onclick={save}
          disabled={saving || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}
        >
          {saving ? "Saving…" : editing ? "Save changes" : "Add server"}
        </button>
      </div>
    </footer>
  </div>
</div>
