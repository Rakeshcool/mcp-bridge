<script lang="ts">
  import { statusClass, statusDot, statusLabel, transportEndpoint, transportLabel } from "./api.ts";
  import type { ServerView } from "./api.ts";

  interface Props {
    server: ServerView;
    busy: string;
    onclose: () => void;
    onapprove: (connect: boolean) => void;
    onreject: () => void;
  }

  let { server, busy, onclose, onapprove, onreject }: Props = $props();

  const working = $derived(busy.startsWith(server.id));
  const isConnector = $derived(server.transport === "connector");
  // A manifest server is something the bridge would launch; a connector is already running and
  // only asks for its tools to be exposed, so the two must not share one warning.
  const target = $derived(
    server.transport === "stdio"
      ? [server.connection.command, ...(server.connection.args ?? [])].join(" ")
      : transportEndpoint(server),
  );
  const shortHash = $derived(server.manifestHash ? server.manifestHash.slice(0, 16) : "—");
</script>

<div
  class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose();
  }}
>
  <section class="w-full max-w-xl rounded-xl border border-warn/40 bg-panel p-5 shadow-2xl">
    <div class="flex items-start gap-3">
      <div class="min-w-0">
        <h2 class="truncate text-sm font-semibold">{server.name}</h2>
        <p class="mt-0.5 text-[11px] text-dim">
          {isConnector ? "connected to this bridge by its own panel" : "discovered from a registration manifest"}
          {#if server.application}
            · {server.application.name}{server.application.version ? ` ${server.application.version}` : ""}
            {#if server.application.extensionType}· {server.application.extensionType}{/if}
          {/if}
        </p>
      </div>
      <div class="ml-auto flex items-center gap-1.5 text-xs {statusClass(server.runtime.status)}">
        <span class="h-1.5 w-1.5 rounded-full {statusDot(server.runtime.status)}"></span>
        {statusLabel(server.runtime.status)}
      </div>
    </div>

    <p class="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] text-warn">
      {#if isConnector}
        This application is already running and is asking to expose its tools here. Approving makes those tools callable by every client that
        uses this bridge.
      {:else}
        Approving lets this program start on your machine and expose tools to every client that uses this bridge. Only approve software you
        installed and expect to run.
      {/if}
    </p>

    <dl class="mt-3 space-y-2 text-[11px]">
      <div class="rounded-lg border border-edge bg-panel-2 p-2.5">
        <dt class="text-dim">{isConnector ? "Connects from" : "Will run"} ({transportLabel(server.transport)})</dt>
        <dd class="mono mt-1 break-all text-ink">{target}</dd>
        {#if server.connection.cwd}<dd class="mono mt-1 break-all text-dim">cwd: {server.connection.cwd}</dd>{/if}
      </div>
      {#if server.manifestPath}
        <div class="rounded-lg border border-edge bg-panel-2 p-2.5">
          <dt class="text-dim">Manifest</dt>
          <dd class="mono mt-1 break-all">{server.manifestPath}</dd>
          <dd class="mono mt-1 text-dim">sha256 {shortHash}…</dd>
        </div>
      {/if}
      {#if server.capabilities.length}
        <div class="rounded-lg border border-edge bg-panel-2 p-2.5">
          <dt class="text-dim">Capabilities</dt>
          <dd class="mt-1 flex flex-wrap gap-1">
            {#each server.capabilities as capability}
              <span class="rounded bg-edge px-1.5 py-0.5 text-[10px] text-muted">{capability}</span>
            {/each}
          </dd>
        </div>
      {/if}
    </dl>

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <button
        class="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-base hover:bg-accent-2 disabled:opacity-50"
        onclick={() => onapprove(true)}
        disabled={working}>Approve &amp; connect</button
      >
      <button
        class="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:border-edge-2 hover:text-ink disabled:opacity-50"
        onclick={() => onapprove(false)}
        disabled={working}>Approve only</button
      >
      <button
        class="ml-auto rounded-lg border border-bad/30 px-3 py-1.5 text-xs text-bad/80 hover:bg-bad/10 disabled:opacity-50"
        onclick={onreject}
        disabled={working}>Reject</button
      >
    </div>
  </section>
</div>
