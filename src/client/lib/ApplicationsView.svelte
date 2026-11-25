<script lang="ts">
  import { call, formatTime, statusClass, statusDot, statusLabel, transportEndpoint, transportLabel } from "./api.ts";
  import type {
    AppState,
    ConnectionsSettings,
    DiscoveryEntry,
    DiscoverySettings,
    ServerView,
  } from "./api.ts";
  import ApprovalSheet from "./ApprovalSheet.svelte";

  interface Props {
    appState: AppState | null;
    busy: string;
    onrefresh: () => Promise<void>;
    onflash: (text: string) => void;
    onopen: (server: ServerView) => void;
    onaction: (server: ServerView, kind: string) => void;
    onedit: (server: ServerView) => void;
  }

  let { appState, busy, onrefresh, onflash, onopen, onaction, onedit }: Props = $props();

  let discovery = $state<DiscoverySettings>({
    enabled: true,
    watchRegistrationDirectory: true,
    autoRegister: false,
    requireApproval: true,
  });
  let connections = $state<ConnectionsSettings>({ autoConnect: false, autoReconnect: true, maxRetries: 5 });
  let signature = $state("");
  let saving = $state(false);
  let localBusy = $state("");
  let reviewing = $state<ServerView | null>(null);

  $effect(() => {
    const current = appState?.bridge;
    if (!current) return;
    const key = JSON.stringify([current.discovery, current.connections]);
    if (key !== signature) {
      signature = key;
      if (current.discovery) discovery = { ...current.discovery };
      if (current.connections) connections = { ...current.connections };
    }
  });

  const state = $derived(appState?.discovery ?? null);
  /** Anything not approved yet, whether it came from a manifest or dialled in over the connector. */
  const pendingServers = $derived(servers.filter((server) => !server.approved));
  const servers = $derived(appState?.servers ?? []);
  const problems = $derived<DiscoveryEntry[]>(
    (state?.entries ?? []).filter((entry) => ["invalid", "conflict"].includes(entry.outcome)),
  );
  const unchanged = $derived(
    (state?.entries ?? []).filter((entry) => entry.outcome === "unchanged").length,
  );

  const field = "w-full rounded-lg border border-edge bg-base px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

  async function rescan(): Promise<void> {
    localBusy = "scan";
    try {
      await call("/api/discovery/rescan", { method: "POST", body: {} });
      await onrefresh();
      onflash("Registration directory rescanned");
    } catch (error) {
      onflash((error as Error).message);
    } finally {
      localBusy = "";
    }
  }

  async function approve(server: ServerView, connect: boolean): Promise<void> {
    localBusy = `${server.id}:approve`;
    try {
      const result: any = await call(`/api/discovery/${encodeURIComponent(server.id)}/approve`, {
        method: "POST",
        body: { connect },
      });
      reviewing = null;
      await onrefresh();
      if (result?.connectError) onflash(`Approved, but connecting failed: ${result.connectError}`);
      else onflash(`Approved ${server.name}${connect ? " and connected" : ""}`);
    } catch (error) {
      onflash((error as Error).message);
    } finally {
      localBusy = "";
    }
  }

  async function reject(server: ServerView): Promise<void> {
    localBusy = `${server.id}:reject`;
    try {
      await call(`/api/discovery/${encodeURIComponent(server.id)}/reject`, { method: "POST", body: {} });
      reviewing = null;
      await onrefresh();
      onflash(`Rejected ${server.name}`);
    } catch (error) {
      onflash((error as Error).message);
    } finally {
      localBusy = "";
    }
  }

  async function forget(server: ServerView): Promise<void> {
    const confirmed = window.confirm(
      `Remove "${server.name}" and ignore this exact manifest until it changes?\n\nThe registration file is left in place.`,
    );
    if (!confirmed) return;
    localBusy = `${server.id}:forget`;
    try {
      await call(`/api/discovery/${encodeURIComponent(server.id)}/forget`, { method: "POST", body: {} });
      await onrefresh();
      onflash(`Removed ${server.name}`);
    } catch (error) {
      onflash((error as Error).message);
    } finally {
      localBusy = "";
    }
  }

  async function copyDirectory(): Promise<void> {
    if (!state) return;
    try {
      await navigator.clipboard.writeText(state.directory);
      onflash("Registration directory copied");
    } catch {
      onflash(state.directory);
    }
  }

  async function saveSettings(): Promise<void> {
    saving = true;
    try {
      await call("/api/bridge", { method: "PUT", body: { discovery, connections } });
      await onrefresh();
      onflash("Discovery settings saved");
    } catch (error) {
      onflash((error as Error).message);
    } finally {
      saving = false;
    }
  }
</script>

<div class="flex flex-wrap items-end justify-between gap-3">
  <div>
    <h2 class="text-lg font-semibold">Connected Applications</h2>
    <p class="mt-0.5 max-w-2xl text-xs text-muted">
      Applications register themselves by dropping a manifest into the directory below. A discovered server is not trusted until you approve
      it, and approval is tied to the exact command or URL it will run.
    </p>
  </div>
  <button
    class="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:border-edge-2 hover:text-ink disabled:opacity-50"
    onclick={rescan}
    disabled={localBusy === "scan" || !state?.enabled}
  >
    {localBusy === "scan" ? "Scanning…" : "Rescan now"}
  </button>
</div>

<div class="mt-4 rounded-xl border border-edge bg-panel p-4">
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-[11px] uppercase tracking-wide text-dim">Registration directory</span>
    <span class="h-1.5 w-1.5 rounded-full {state?.directoryAvailable ? 'bg-ok' : 'bg-bad'}"></span>
    <span class="text-[11px] text-muted">
      {state?.enabled ? (state?.directoryAvailable ? "available" : "missing") : "discovery disabled"}
      {#if state?.watching}· watching{/if}
    </span>
    <button class="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-accent hover:bg-edge" onclick={copyDirectory}>copy</button>
  </div>
  <code class="mono mt-1 block break-all text-[11px] text-ink">{state?.directory ?? "—"}</code>
  <p class="mt-1 text-[11px] text-dim">
    Last scan {state?.lastScanAt ? formatTime(state.lastScanAt) : "never"} · fs.watch plus a 15 s rescan, because synced folders drop events
  </p>
</div>

{#if appState?.connector?.enabled}
  <div class="mt-4 rounded-xl border border-edge bg-panel p-4">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[11px] uppercase tracking-wide text-dim">Connector</span>
      <span class="h-1.5 w-1.5 rounded-full {appState.connector.connections.length ? 'bg-ok' : 'bg-dim'}"></span>
      <span class="text-[11px] text-muted">
        {appState.connector.connections.length} panel{appState.connector.connections.length === 1 ? "" : "s"} connected
        {#if appState.connector.tokenRequired}· token required{/if}
      </span>
    </div>
    <code class="mono mt-1 block break-all text-[11px] text-ink">ws://{typeof location !== "undefined" ? location.host : "127.0.0.1:7800"}{appState.connector.path}</code>
    <p class="mt-1 text-[11px] text-dim">
      Applications that dial in here (the After Effects panel) register like a manifest and wait for approval.
    </p>
    {#if appState.connector.lastError}
      <p class="mt-1 break-all text-[11px] text-bad/80">{appState.connector.lastError.message}</p>
    {/if}
  </div>
{/if}

{#if pendingServers.length > 0}
  <div class="mt-4 rounded-xl border border-warn/40 bg-panel p-4">
    <h3 class="text-sm font-semibold text-warn">Waiting for approval ({pendingServers.length})</h3>
    <ul class="mt-3 space-y-2">
      {#each pendingServers as server (server.id)}
        <li class="rounded-lg border border-warn/30 bg-warn/5 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs font-medium">{server.name}</span>
            {#if server.application}
              <span class="rounded bg-edge px-1.5 py-0.5 text-[10px] text-muted"
                >{server.application.name}{server.application.version ? ` ${server.application.version}` : ""}</span
              >
            {/if}
            <span class="rounded bg-edge px-1.5 py-0.5 text-[10px] uppercase text-dim">{server.source}</span>
            <span class="mono text-[10px] text-dim">{server.id}</span>
            <div class="ml-auto flex gap-2">
                <button
                  class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink"
                  onclick={() => (reviewing = server)}>Review</button
                >
                <button
                  class="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-base hover:bg-accent-2 disabled:opacity-50"
                  onclick={() => approve(server, true)}
                  disabled={localBusy.length > 0}>Approve &amp; connect</button
                >
                <button
                  class="rounded-md border border-bad/30 px-2.5 py-1 text-[11px] text-bad/80 hover:bg-bad/10 disabled:opacity-50"
                  onclick={() => reject(server)}
                  disabled={localBusy.length > 0}>Reject</button
                >
            </div>
          </div>
          <p class="mono mt-1 break-all text-[10px] text-dim">
            {server.source === "connector" ? `connector · ${appState?.connector?.path ?? "/ws/connector"}` : server.manifestPath ?? "—"}
          </p>
          {#if server.capabilities.length}
            <div class="mt-1 flex flex-wrap gap-1">
              {#each server.capabilities as capability}
                <span class="rounded bg-edge px-1.5 py-0.5 text-[10px] text-muted">{capability}</span>
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="mt-2 text-[11px] text-dim">Discovery is not authorization: nothing here runs until you approve it.</p>
  </div>
{/if}

<div class="mt-4 grid gap-3">
  {#if appState === null}
    <div class="rounded-xl border border-edge bg-panel px-4 py-8 text-center text-sm text-dim">Loading…</div>
  {:else if servers.length === 0}
    <div class="rounded-xl border border-dashed border-edge-2 bg-panel px-4 py-10 text-center text-sm text-muted">
      No applications yet. Install an integration and its manifest will appear in the registration directory.
    </div>
  {:else}
    {#each servers as server (server.id)}
      <div class="rounded-xl border border-edge bg-panel p-4">
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="truncate text-sm font-semibold">{server.name}</h3>
              <span class="rounded-md border border-edge bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-dim"
                >{transportLabel(server.transport)}</span
              >
              {#if server.source === "manifest"}
                <span class="rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">discovered</span>
              {:else}
                <span class="rounded-md bg-edge px-1.5 py-0.5 text-[10px] text-muted">{server.source}</span>
              {/if}
              {#if !server.approved}
                <span class="rounded-md bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">needs approval</span>
              {/if}
              {#if server.manifestMissing}
                <span class="rounded-md bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">manifest removed</span>
              {/if}
            </div>
            {#if server.application}
              <p class="mt-1 text-[11px] text-muted">
                {server.application.name}{server.application.version ? ` ${server.application.version}` : ""}
                {#if server.application.extensionType}· {server.application.extensionType}{/if}
              </p>
            {:else if server.description}
              <p class="mt-1 line-clamp-2 text-[11px] text-muted">{server.description}</p>
            {/if}
            <p class="mono mt-1 truncate text-[11px] text-dim">{transportEndpoint(server)}</p>
            {#if server.capabilities.length}
              <div class="mt-1.5 flex flex-wrap gap-1">
                {#each server.capabilities.slice(0, 8) as capability}
                  <span class="rounded bg-edge px-1.5 py-0.5 text-[10px] text-muted">{capability}</span>
                {/each}
              </div>
            {/if}
          </div>
          <div class="shrink-0 text-right">
            <div class="flex items-center justify-end gap-1.5 text-xs {statusClass(server.runtime.status)}">
              <span class="h-1.5 w-1.5 rounded-full {statusDot(server.runtime.status)}"></span>
              {statusLabel(server.runtime.status)}
            </div>
            <div class="mt-1 text-[11px] text-dim">
              {server.runtime.toolCount} tools
              {#if server.runtime.pid !== null}· pid {server.runtime.pid}{/if}
            </div>
            {#if server.runtime.lastError}
              <div class="mono mt-1 max-w-[16rem] break-words text-[10px] text-bad">{server.runtime.lastError}</div>
            {/if}
          </div>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-edge pt-3">
          <button class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink" onclick={() => onopen(server)}
            >View tools</button
          >
          <button class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink" onclick={() => onedit(server)}
            >Settings</button
          >
          {#if server.runtime.status === "connected"}
            <button
              class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink disabled:opacity-50"
              onclick={() => onaction(server, "restart")}
              disabled={busy.startsWith(`${server.id}:`)}>Reconnect</button
            >
          {:else}
            <button
              class="rounded-md bg-accent/15 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/25 disabled:opacity-50"
              onclick={() => onaction(server, "connect")}
              disabled={!server.approved || busy.startsWith(`${server.id}:`)}>Connect</button
            >
          {/if}
          {#if !server.approved}
            <button
              class="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-base hover:bg-accent-2 disabled:opacity-50"
              onclick={() => approve(server, true)}
              disabled={localBusy.length > 0}>Approve</button
            >
            <button
              class="rounded-md border border-bad/30 px-2.5 py-1 text-[11px] text-bad/80 hover:bg-bad/10 disabled:opacity-50"
              onclick={() => reject(server)}
              disabled={localBusy.length > 0}>Reject</button
            >
          {/if}
          {#if server.source === "manifest"}
            <button
              class="rounded-md border border-edge px-2.5 py-1 text-[11px] text-muted hover:border-edge-2 hover:text-ink disabled:opacity-50"
              onclick={() => forget(server)}
              disabled={localBusy.length > 0}>Forget</button
            >
          {/if}
          <button
            class="ml-auto rounded-md border border-bad/30 px-2.5 py-1 text-[11px] text-bad/80 hover:bg-bad/10"
            onclick={() => onaction(server, "delete")}>Remove</button
          >
        </div>
      </div>
    {/each}
  {/if}
</div>

{#if problems.length > 0}
  <div class="mt-4 rounded-xl border border-edge bg-panel p-4">
    <h3 class="text-sm font-semibold">Rejected manifests</h3>
    <p class="mt-0.5 text-[11px] text-dim">These files are in the directory but were not registered.</p>
    <ul class="mt-2 space-y-1.5">
      {#each problems as entry (entry.manifestPath + entry.id)}
        <li class="rounded-lg border border-edge bg-panel-2 p-2.5">
          <div class="flex flex-wrap items-center gap-2 text-[11px]">
            <span class="mono text-ink">{entry.id}</span>
            <span class="rounded bg-edge px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warn">{entry.outcome}</span>
          </div>
          <p class="mono mt-1 break-all text-[10px] text-dim">{entry.manifestPath}</p>
          {#if entry.error}<p class="mt-1 text-[10px] text-bad">{entry.error}</p>{/if}
        </li>
      {/each}
    </ul>
  </div>
{:else if unchanged > 0}
  <p class="mt-3 text-[11px] text-dim">
    {unchanged} manifest{unchanged === 1 ? "" : "s"} unchanged since the last scan.
  </p>
{/if}

<div class="mt-4 rounded-xl border border-edge bg-panel p-4">
  <h3 class="text-sm font-semibold">Discovery &amp; connection policy</h3>
  <div class="mt-3 space-y-2 text-xs">
    <label class="flex items-center gap-2">
      <input type="checkbox" bind:checked={discovery.enabled} />
      <span>Watch for registration manifests</span>
    </label>
    <label class="flex items-center gap-2">
      <input type="checkbox" bind:checked={discovery.watchRegistrationDirectory} disabled={!discovery.enabled} />
      <span>Use fs.watch (15 s rescan still runs when off)</span>
    </label>
    <label class="flex items-center gap-2">
      <input type="checkbox" bind:checked={discovery.autoRegister} disabled={!discovery.enabled} />
      <span>Register new manifests without asking</span>
    </label>
    <label class="flex items-center gap-2">
      <input type="checkbox" bind:checked={discovery.requireApproval} disabled={!discovery.enabled} />
      <span>Require approval before a discovered server may connect</span>
    </label>
    <label class="flex items-center gap-2">
      <input type="checkbox" bind:checked={connections.autoConnect} />
      <span>Connect approved servers on bridge startup</span>
    </label>
    <label class="flex items-center gap-2">
      <input type="checkbox" bind:checked={connections.autoReconnect} />
      <span>Reconnect after a crash (exponential backoff)</span>
    </label>
    <div class="grid gap-3 pt-1">
      <div>
        <label class="text-[11px] uppercase tracking-wide text-dim" for="discovery-retries">Max retries</label>
        <input id="discovery-retries" class={field} type="number" min="0" max="20" bind:value={connections.maxRetries} />
      </div>
    </div>
    <button
      class="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-base hover:bg-accent-2 disabled:opacity-50"
      onclick={saveSettings}
      disabled={saving}>{saving ? "Saving…" : "Save policy"}</button
    >
  </div>
</div>

{#if reviewing}
  <ApprovalSheet
    server={reviewing}
    {busy}
    onclose={() => (reviewing = null)}
    onapprove={(connect) => approve(reviewing as ServerView, connect)}
    onreject={() => reject(reviewing as ServerView)}
  />
{/if}
