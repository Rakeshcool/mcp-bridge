<script lang="ts">
  import { statusClass, statusDot, statusLabel, transportEndpoint, transportLabel } from "./api.ts";
  import type { ServerView } from "./api.ts";

  interface Props {
    server: ServerView;
    busy: string;
    onopen: () => void;
    onaction: (kind: string) => void;
    onedit: () => void;
  }

  let { server, busy, onopen, onaction, onedit }: Props = $props();

  const connected = $derived(server.runtime.status === "connected");
  const working = $derived(busy.startsWith(`${server.id}:`));
  const pending = $derived(["starting", "stopping", "reconnecting"].includes(server.runtime.status));
</script>

<div class="rounded-xl border border-edge bg-panel p-4 transition-colors hover:border-edge-2">
  <div class="flex items-start gap-3">
    <button class="min-w-0 flex-1 text-left" onclick={onopen}>
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="truncate text-sm font-semibold">{server.name}</h3>
        <span class="rounded-md border border-edge bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-dim"
          >{transportLabel(server.transport)}</span
        >
        {#if !server.enabled}
          <span class="rounded-md bg-edge px-1.5 py-0.5 text-[10px] text-muted">disabled</span>
        {/if}
        {#if server.visibility === "hidden_until_mentioned"}
          <span class="rounded-md bg-edge px-1.5 py-0.5 text-[10px] text-muted">hidden until @mentioned</span>
        {/if}
        {#if !server.approved}
          <span class="rounded-md bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">needs approval</span>
        {/if}
      </div>
      <p class="mt-1 line-clamp-2 text-xs text-muted">{server.description || "No description"}</p>
      <p class="mono mt-1.5 truncate text-[11px] text-dim">{transportEndpoint(server)}</p>
    </button>
    <div class="shrink-0 text-right">
      <div class="flex items-center justify-end gap-1.5 text-xs {statusClass(server.runtime.status)}">
        <span class="h-1.5 w-1.5 rounded-full {statusDot(server.runtime.status)}"></span>
        {statusLabel(server.runtime.status)}
      </div>
      <div class="mt-1 text-[11px] text-dim">
        {server.runtime.toolCount} tools
        {#if server.runtime.pid !== null}· pid {server.runtime.pid}{/if}
      </div>
    </div>
  </div>

  <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-edge pt-3">
    {#if connected}
      <button class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink" onclick={() => onaction("disconnect")} disabled={working}
        >Disconnect</button
      >
      <button class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink" onclick={() => onaction("restart")} disabled={working}
        >Restart</button
      >
    {:else}
      <button
        class="rounded-md bg-accent/15 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/25 disabled:opacity-50"
        onclick={() => onaction("connect")}
        title={server.approved ? undefined : "Approve this discovered server in Applications first"}
        disabled={working || pending || !server.enabled || !server.approved}>Connect</button
      >
    {/if}
    <button class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink" onclick={onedit}>Edit</button>
    <button class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink" onclick={() => onaction("enable")}>
      {server.enabled ? "Disable" : "Enable"}
    </button>
    <button class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink" onclick={onopen}>Details</button>
    <button class="ml-auto rounded-md border border-bad/30 px-2.5 py-1 text-[11px] text-bad/80 hover:bg-bad/10" onclick={() => onaction("delete")}>Delete</button>
  </div>
</div>
