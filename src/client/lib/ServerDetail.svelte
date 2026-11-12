<script lang="ts">
  import { call, formatTime, statusClass, statusDot, statusLabel, transportLabel } from "./api.ts";
  import type { ServerView } from "./api.ts";

  interface Props {
    server: ServerView;
    busy: string;
    onclose: () => void;
    onaction: (kind: string) => void;
    ontool: (exposedName: string, patch: Record<string, unknown>) => void;
    onedit: () => void;
  }

  let { server, busy, onclose, onaction, ontool, onedit }: Props = $props();

  let tab = $state<"overview" | "tools" | "logs" | "config">("overview");
  let openSchema = $state("");

  const connected = $derived(server.runtime.status === "connected");

  async function refreshTools(): Promise<void> {
    try {
      await call(`/api/servers/${server.id}/tools/refresh`, { method: "POST" });
    } catch (error) {
      alert((error as Error).message);
    }
  }

  const tabClass = (name: string) =>
    tab === name
      ? "rounded-md bg-edge px-3 py-1.5 text-xs text-ink"
      : "rounded-md px-3 py-1.5 text-xs text-muted hover:text-ink";
</script>

<div
  class="fixed inset-0 z-30 flex justify-end bg-black/50"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose();
  }}
>
  <section class="h-full w-full max-w-3xl overflow-y-auto border-l border-edge bg-panel">
    <header class="sticky top-0 z-10 border-b border-edge bg-panel px-5 py-4">
      <div class="flex items-start gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="truncate text-base font-semibold">{server.name}</h2>
            <span class="rounded-md border border-edge bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-dim"
              >{transportLabel(server.transport)}</span
            >
          </div>
          <div class="mt-1 flex items-center gap-1.5 text-xs {statusClass(server.runtime.status)}">
            <span class="h-1.5 w-1.5 rounded-full {statusDot(server.runtime.status)}"></span>
            {statusLabel(server.runtime.status)}
            {#if server.runtime.pid !== null}<span class="text-dim">· pid {server.runtime.pid}</span>{/if}
          </div>
        </div>
        <button class="ml-auto rounded-md border border-edge px-2.5 py-1 text-xs text-muted hover:text-ink" onclick={onclose}>Close</button>
      </div>
      <div class="mt-3 flex gap-1 rounded-lg border border-edge bg-panel-2 p-0.5">
        <button class={tabClass("overview")} onclick={() => (tab = "overview")}>Overview</button>
        <button class={tabClass("tools")} onclick={() => (tab = "tools")}>Tools ({server.runtime.toolCount})</button>
        <button class={tabClass("logs")} onclick={() => (tab = "logs")}>Logs</button>
        <button class={tabClass("config")} onclick={() => (tab = "config")}>Configuration</button>
      </div>
    </header>

    <div class="px-5 py-4">
      {#if tab === "overview"}
        <dl class="grid grid-cols-2 gap-3 text-xs">
          <div class="rounded-lg border border-edge bg-panel-2 p-3">
            <dt class="text-dim">Enabled</dt>
            <dd class="mt-1">{server.enabled ? "Yes" : "No"}</dd>
          </div>
          <div class="rounded-lg border border-edge bg-panel-2 p-3">
            <dt class="text-dim">Visibility</dt>
            <dd class="mt-1">{server.visibility === "normal" ? "Always available" : "Hidden until @mentioned"}</dd>
          </div>
          <div class="rounded-lg border border-edge bg-panel-2 p-3">
            <dt class="text-dim">Last connected</dt>
            <dd class="mt-1">{formatTime(server.runtime.lastConnected)}</dd>
          </div>
          <div class="rounded-lg border border-edge bg-panel-2 p-3">
            <dt class="text-dim">Tool calls</dt>
            <dd class="mt-1">{server.runtime.calls}</dd>
          </div>
          <div class="col-span-2 rounded-lg border border-edge bg-panel-2 p-3">
            <dt class="text-dim">{server.transport === "stdio" ? "Command" : "Endpoint"}</dt>
            <dd class="mono mt-1 break-all text-[11px]">
              {server.transport === "stdio" ? server.connection.command : server.connection.url}
              {#if server.transport === "stdio" && server.connection.args.length}
                {#each server.connection.args as arg}
                  <span class="text-muted"> {arg}</span>
                {/each}
              {/if}
            </dd>
            {#if server.transport === "stdio" && server.connection.cwd}
              <dd class="mono mt-1 text-[11px] text-dim">cwd: {server.connection.cwd}</dd>
            {/if}
          </div>
          {#if server.runtime.lastError}
            <div class="col-span-2 rounded-lg border border-bad/40 bg-bad/10 p-3 text-bad">
              <dt class="text-[11px] uppercase tracking-wide">Last error</dt>
              <dd class="mono mt-1 break-words text-[11px]">{server.runtime.lastError}</dd>
            </div>
          {/if}
        </dl>

        <div class="mt-4 flex flex-wrap gap-2">
          {#if connected}
            <button class="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink" onclick={() => onaction("disconnect")}>Disconnect</button>
            <button class="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink" onclick={() => onaction("restart")}>Restart</button>
          {:else}
            <button
              class="rounded-md bg-accent/15 px-3 py-1.5 text-xs text-accent hover:bg-accent/25 disabled:opacity-50"
              onclick={() => onaction("connect")}
              disabled={!server.enabled || busy.startsWith(server.id)}>Connect</button
            >
          {/if}
          <button class="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink" onclick={onedit}>Edit configuration</button>
          <span class="ml-auto self-center text-[11px] text-dim">
            startup {Math.round(server.startupTimeoutMs / 1000)}s · tool {Math.round(server.toolTimeoutMs / 1000)}s ·
            {server.idleTimeoutMs ? `idle ${Math.round(server.idleTimeoutMs / 1000)}s` : "no idle stop"}
          </span>
        </div>
      {:else if tab === "tools"}
        <div class="mb-3 flex items-center justify-between">
          <p class="text-xs text-muted">Permissions are enforced inside the bridge, not by this panel.</p>
          <button
            class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:text-ink disabled:opacity-40"
            onclick={refreshTools}
            disabled={!connected}>Refresh discovery</button
          >
        </div>
        {#if server.runtime.tools.length === 0}
          <p class="rounded-lg border border-dashed border-edge-2 px-4 py-8 text-center text-xs text-dim">
            No tools discovered yet. Connect the server to run <code class="mono">tools/list</code>.
          </p>
        {:else}
          <ul class="space-y-2">
            {#each server.runtime.tools as tool (tool.name)}
              <li class="rounded-lg border border-edge bg-panel-2 p-3">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="mono text-xs text-ink">{tool.name}</span>
                  <span class="mono rounded bg-edge px-1.5 py-0.5 text-[10px] text-dim">{tool.exposedName}</span>
                  <div class="ml-auto flex items-center gap-2 text-[11px]">
                    <label class="flex items-center gap-1 text-muted">
                      <input
                        type="checkbox"
                        checked={tool.enabled}
                        onchange={(event) => ontool(tool.exposedName, { enabled: (event.currentTarget as HTMLInputElement).checked })}
                      />
                      enabled
                    </label>
                    <select
                      class="rounded border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-ink"
                      value={tool.permission}
                      onchange={(event) => ontool(tool.exposedName, { permission: (event.currentTarget as HTMLSelectElement).value })}
                    >
                      <option value="allow">Allow</option>
                      <option value="ask">Ask</option>
                      <option value="deny">Deny</option>
                    </select>
                  </div>
                </div>
                <p class="mt-1 line-clamp-2 text-[11px] text-muted">{tool.description || "No description"}</p>
                <button
                  class="mt-1.5 text-[11px] text-accent hover:underline"
                  onclick={() => (openSchema = openSchema === tool.name ? "" : tool.name)}>schema</button
                >
                {#if openSchema === tool.name}
                  <pre class="mono mt-1.5 max-h-64 overflow-auto rounded bg-base p-2 text-[10px] text-muted"
                    >{JSON.stringify(tool.inputSchema, null, 2)}</pre
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {:else if tab === "logs"}
        <div class="max-h-[65vh] overflow-auto rounded-lg border border-edge bg-base p-3">
          {#if server.logs.length === 0}
            <p class="text-xs text-dim">No log output yet.</p>
          {:else}
            {#each server.logs as entry}
              <div class="mono flex gap-2 py-0.5 text-[11px] leading-relaxed">
                <span class="shrink-0 text-dim">{new Date(entry.ts).toLocaleTimeString([], { hour12: false })}</span>
                <span
                  class="shrink-0 {entry.level === 'error' ? 'text-bad' : entry.level === 'warn' ? 'text-warn' : entry.level === 'stderr' ? 'text-muted' : 'text-accent'}"
                  >{entry.level}</span
                >
                <span class="break-all text-muted">{entry.message}</span>
              </div>
            {/each}
          {/if}
        </div>
      {:else}
        <p class="mb-3 text-xs text-muted">Secrets are stored outside this file and never returned by the API.</p>
        <pre class="mono max-h-[60vh] overflow-auto rounded-lg border border-edge bg-base p-3 text-[11px] text-muted"
          >{JSON.stringify(
            {
              id: server.id,
              name: server.name,
              enabled: server.enabled,
              visibility: server.visibility,
              transport: server.transport,
              connection: server.connection,
              startupTimeoutMs: server.startupTimeoutMs,
              toolTimeoutMs: server.toolTimeoutMs,
              idleTimeoutMs: server.idleTimeoutMs,
              restartPolicy: server.restartPolicy,
            },
            null,
            2,
          )}</pre
        >
        <button class="mt-3 rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink" onclick={onedit}>Edit configuration</button>
      {/if}
    </div>
  </section>
</div>
