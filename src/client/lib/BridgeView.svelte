<script lang="ts">
  import { call, formatTime } from "./api.ts";
  import type { ActivityRecord, AppState, BridgeSettings, ToolCallRecord } from "./api.ts";

  interface Props {
    appState: AppState | null;
    onrefresh: () => Promise<void>;
    onflash: (text: string) => void;
  }

  let { appState, onrefresh, onflash }: Props = $props();

  let settings = $state<BridgeSettings>({ baseUrl: "http://127.0.0.1:8080", model: "", maxRounds: 5, toolTimeoutMs: 60000, requestTimeoutMs: 600000 });
  let signature = $state("");
  let saving = $state(false);

  $effect(() => {
    const current = appState?.bridge;
    if (!current) return;
    const key = JSON.stringify(current);
    if (key !== signature) {
      signature = key;
      settings = { ...current };
    }
  });

  const baseUrl = $derived(typeof location !== "undefined" ? `${location.origin}/v1` : "http://127.0.0.1:7800/v1");
  const mcpUrl = $derived(`${typeof location !== "undefined" ? location.origin : "http://127.0.0.1:7800"}${appState?.mcp?.path ?? "/mcp"}`);
  const activity = $derived(appState?.activity ?? []);

  async function saveSettings(): Promise<void> {
    saving = true;
    try {
      const result: any = await call("/api/bridge", { method: "PUT", body: settings });
      settings = { ...result.settings };
      await onrefresh();
      onflash("Bridge settings saved");
    } catch (error) {
      onflash((error as Error).message);
    } finally {
      saving = false;
    }
  }

  async function copyBaseUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(baseUrl);
      onflash("base_url copied");
    } catch {
      onflash(baseUrl);
    }
  }

  async function copyMcpUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      onflash("MCP endpoint copied");
    } catch {
      onflash(mcpUrl);
    }
  }

  const field = "w-full rounded-lg border border-edge bg-base px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
  const label = "text-[11px] uppercase tracking-wide text-dim";
</script>

<div class="grid gap-4 lg:grid-cols-[1.05fr_1fr]">
  <section class="space-y-4">
    <div class="rounded-xl border border-edge bg-panel p-4">
      <div class="flex items-center gap-2">
        <span class="h-1.5 w-1.5 rounded-full {appState?.upstream.reachable ? 'bg-ok' : 'bg-bad'}"></span>
        <h2 class="text-sm font-semibold">Upstream llama-server</h2>
        <span class="ml-auto text-[11px] text-dim">{appState?.upstream.reachable ? "reachable" : appState?.upstream.error ?? "unreachable"}</span>
      </div>
      <p class="mono mt-2 truncate text-[11px] text-muted">{appState?.upstream.model || "no model reported"}</p>
      <p class="mono mt-0.5 truncate text-[11px] text-dim">{appState?.upstream.baseUrl}</p>

      <div class="mt-3 rounded-lg border border-edge bg-panel-2 p-2.5">
        <div class="flex items-center gap-2">
          <span class="text-[11px] uppercase tracking-wide text-dim">Base URL for any OpenAI client</span>
          <button class="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-accent hover:bg-edge" onclick={copyBaseUrl}>copy</button>
        </div>
        <code class="mono mt-1 block break-all text-xs text-ink">{baseUrl}</code>
        <p class="mt-1 text-[11px] text-dim">
          Point a client here instead of at the llama-server port. It needs no <code class="mono">tools</code> of its own — the bridge
          injects the enabled MCP tools and runs the calls.
        </p>
      </div>

      <div class="mt-2 rounded-lg border border-edge bg-panel-2 p-2.5">
        <div class="flex items-center gap-2">
          <span class="text-[11px] uppercase tracking-wide text-dim">MCP endpoint for other MCP clients</span>
          <button class="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-accent hover:bg-edge" onclick={copyMcpUrl}>copy</button>
        </div>
        <code class="mono mt-1 block break-all text-xs text-ink">{mcpUrl}</code>
        <p class="mt-1 text-[11px] text-dim">
          Register this URL as a Streamable HTTP MCP server. It serves the same tools, permissions and idle reconnects as the chat path,
          and needs no API key — it only answers on this machine.
        </p>
      </div>
    </div>

    <div class="rounded-xl border border-edge bg-panel p-4">
      <h2 class="text-sm font-semibold">Bridge settings</h2>
      <div class="mt-3 space-y-3">
        <div>
          <label class={label} for="bridge-base">llama-server base URL</label>
          <input id="bridge-base" class={field} bind:value={settings.baseUrl} />
        </div>
        <div>
          <label class={label} for="bridge-model">Model override</label>
          <input id="bridge-model" class={field} bind:value={settings.model} placeholder="leave blank to use the server's loaded model" />
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div>
            <label class={label} for="bridge-rounds">Max tool rounds</label>
            <input id="bridge-rounds" class={field} type="number" min="1" max="12" bind:value={settings.maxRounds} />
          </div>
          <div>
            <label class={label} for="bridge-tool">Tool timeout (ms)</label>
            <input id="bridge-tool" class={field} type="number" min="1000" bind:value={settings.toolTimeoutMs} />
          </div>
          <div>
            <label class={label} for="bridge-request">Request timeout (ms)</label>
            <input id="bridge-request" class={field} type="number" min="5000" bind:value={settings.requestTimeoutMs} />
          </div>
        </div>
        <button
          class="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-base hover:bg-accent-2 disabled:opacity-50"
          onclick={saveSettings}
          disabled={saving}>{saving ? "Saving…" : "Save bridge settings"}</button
        >
      </div>
    </div>

  </section>

  <section class="rounded-xl border border-edge bg-panel p-4">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold">Activity</h2>
      <span class="text-[11px] text-dim">{activity.length} recent request{activity.length === 1 ? "" : "s"}</span>
    </div>
    {#if activity.length === 0}
      <p class="mt-3 rounded-lg border border-dashed border-edge-2 px-3 py-10 text-center text-[11px] text-dim">
        No bridged requests yet. Send one with curl or any OpenAI client.
      </p>
    {:else}
      <ul class="mt-3 space-y-2">
        {#each activity as record (record.id)}
          <li class="rounded-lg border border-edge bg-panel-2 p-3">
            <div class="flex items-center gap-2 text-[11px] text-dim">
              <span>{formatTime(record.startedAt)}</span>
              <span>·</span>
              <span>{record.durationMs}ms</span>
              <span>·</span>
              <span>{record.rounds.length} round{record.rounds.length === 1 ? "" : "s"}</span>
              <span>·</span>
              <span>{record.injectedTools} tools injected</span>
              {#if record.error}<span class="ml-auto text-bad">failed</span>{/if}
            </div>
            <p class="mt-1 text-[11px] text-muted">
              {record.usage.total_tokens} tokens · {record.finalChars} chars out · {record.model}
            </p>
            {#if record.error}
              <p class="mono mt-1 break-words text-[10px] text-bad">{record.error}</p>
            {/if}
            {#each record.rounds as round}
              {#if round.toolCalls.length}
                <ul class="mt-1.5 space-y-1">
                  {#each round.toolCalls as toolCall}
                    <li class="mono rounded bg-base px-2 py-1 text-[10px]">
                      <span class={toolCall.status === "ok" ? "text-ok" : toolCall.status === "denied" ? "text-warn" : "text-bad"}>{toolCall.status}</span>
                      <span class="text-ink"> {toolCall.toolName}</span>
                      <span class="text-dim"> · {toolCall.permission} · {toolCall.durationMs}ms</span>
                      <span class="block truncate text-dim">{toolCall.args}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            {/each}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
