<script lang="ts">
  import { onMount } from "svelte";
  import { call, getState } from "./lib/api.ts";
  import type { AppState, ApprovalRequest, ServerView } from "./lib/api.ts";
  import ServerCard from "./lib/ServerCard.svelte";
  import ServerDialog from "./lib/ServerDialog.svelte";
  import ServerDetail from "./lib/ServerDetail.svelte";
  import BridgeView from "./lib/BridgeView.svelte";
  import ChatView from "./lib/ChatView.svelte";

  let state = $state<AppState | null>(null);
  let errorMessage = $state("");
  let busy = $state("");
  let view = $state<"chat" | "servers" | "bridge">("chat");
  let selectedId = $state("");
  let dialogOpen = $state(false);
  let dialogTarget = $state<ServerView | null>(null);
  let query = $state("");
  let transportFilter = $state("all");
  let statusFilter = $state("all");
  let approvals = $state<ApprovalRequest[]>([]);
  let toast = $state("");

  const servers = $derived(state?.servers ?? []);
  const filtered = $derived(
    servers.filter((server) => {
      const q = query.trim().toLowerCase();
      if (q && !`${server.name} ${server.description} ${server.id}`.toLowerCase().includes(q)) return false;
      if (transportFilter !== "all" && server.transport !== transportFilter) return false;
      if (statusFilter === "enabled" && !server.enabled) return false;
      if (statusFilter === "connected" && server.runtime.status !== "connected") return false;
      if (statusFilter === "attention" && !["error", "disconnected", "reconnecting"].includes(server.runtime.status)) return false;
      return true;
    }),
  );
  const detail = $derived(servers.find((server) => server.id === selectedId) ?? null);
  const connectedCount = $derived(servers.filter((server) => server.runtime.status === "connected").length);
  const totalTools = $derived(servers.reduce((sum, server) => sum + server.runtime.enabledToolCount, 0));

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleRefresh(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), 350);
  }

  async function refresh(): Promise<void> {
    try {
      state = await getState();
      approvals = state.approvals ?? [];
      errorMessage = "";
    } catch (error) {
      errorMessage = (error as Error).message;
    }
  }

  function flash(text: string): void {
    toast = text;
    setTimeout(() => {
      if (toast === text) toast = "";
    }, 4500);
  }

  async function act(server: ServerView, kind: string): Promise<void> {
    busy = `${server.id}:${kind}`;
    try {
      if (kind === "delete") {
        const confirmed = window.confirm(
          `Delete "${server.name}"?\n\nIts process is stopped, its configuration is removed and any stored secrets are deleted.`,
        );
        if (!confirmed) {
          busy = "";
          return;
        }
        await call(`/api/servers/${server.id}`, { method: "DELETE" });
        if (selectedId === server.id) selectedId = "";
        flash(`Deleted ${server.name}`);
      } else if (kind === "enable") {
        await call(`/api/servers/${server.id}/enable`, { method: "POST", body: { enabled: !server.enabled } });
      } else {
        const result: any = await call(`/api/servers/${server.id}/${kind}`, { method: "POST" });
        if (kind === "connect") flash(`Connected ${server.name} — ${result?.runtime?.toolCount ?? 0} tools discovered`);
        if (kind === "restart") flash(`Restarted ${server.name}`);
        if (kind === "disconnect") flash(`Disconnected ${server.name}`);
      }
      await refresh();
    } catch (error) {
      flash((error as Error).message);
    } finally {
      busy = "";
    }
  }

  async function patchTool(exposedName: string, patch: Record<string, unknown>): Promise<void> {
    try {
      await call(`/api/tools/${encodeURIComponent(exposedName)}`, { method: "PATCH", body: patch });
      await refresh();
    } catch (error) {
      flash((error as Error).message);
    }
  }

  async function resolveApproval(id: string, approved: boolean): Promise<void> {
    try {
      await call(`/api/approvals/${id}`, { method: "POST", body: { approved } });
      approvals = approvals.filter((entry) => entry.id !== id);
    } catch (error) {
      flash((error as Error).message);
    }
  }

  onMount(() => {
    void refresh();
    const events = new EventSource("/api/events");
    for (const type of ["status", "tools", "bridge", "activity", "log"]) {
      events.addEventListener(type, () => scheduleRefresh());
    }
    events.addEventListener("approval_requested", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as ApprovalRequest;
      approvals = [...approvals.filter((entry) => entry.id !== data.id), data];
    });
    events.addEventListener("approval_resolved", (event) => {
      const data = JSON.parse((event as MessageEvent).data);
      approvals = approvals.filter((entry) => entry.id !== data.id);
    });
    return () => events.close();
  });
</script>

<div class="min-h-screen bg-base">
  <header class="sticky top-0 z-20 border-b border-edge bg-panel/95 backdrop-blur">
    <div class="mx-auto flex max-w-6xl items-center gap-5 px-6 py-3">
      <div class="flex items-center gap-2">
        <img src="/logo-256.png" alt="MCP Bridge" class="h-8 w-auto" />
        <h1 class="text-sm font-semibold tracking-wide">MCP Bridge</h1>
        <span class="text-xs text-dim">llama.cpp ⇄ MCP</span>
      </div>
      <nav class="flex gap-1 rounded-lg border border-edge bg-panel-2 p-0.5 text-xs">
        <button
          class={view === "chat" ? "rounded-md bg-edge px-3 py-1.5 text-ink" : "rounded-md px-3 py-1.5 text-muted hover:text-ink"}
          onclick={() => {
            view = "chat";
            selectedId = "";
          }}>Chat</button
        >
        <button
          class={view === "servers" ? "rounded-md bg-edge px-3 py-1.5 text-ink" : "rounded-md px-3 py-1.5 text-muted hover:text-ink"}
          onclick={() => {
            view = "servers";
          }}>Servers</button
        >
        <button
          class={view === "bridge" ? "rounded-md bg-edge px-3 py-1.5 text-ink" : "rounded-md px-3 py-1.5 text-muted hover:text-ink"}
          onclick={() => {
            view = "bridge";
            selectedId = "";
          }}>Bridge</button
        >
      </nav>
      <div class="ml-auto flex items-center gap-3 text-[11px] text-dim">
        <span>{connectedCount}/{servers.length} connected</span>
        <span>·</span>
        <span>{totalTools} tools</span>
        <span class="h-1.5 w-1.5 rounded-full {state?.upstream.reachable ? 'bg-ok' : 'bg-bad'}"></span>
        <span>{state?.upstream.reachable ? "llama-server up" : "llama-server down"}</span>
      </div>
    </div>
  </header>

  <main class="mx-auto max-w-6xl px-6 py-6">
    {#if errorMessage}
      <div class="mb-4 rounded-lg border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">{errorMessage}</div>
    {/if}

    {#each approvals as approval (approval.id)}
      <div class="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
        <span class="font-medium text-warn">Approval needed</span>
        <span class="text-muted">{approval.serverName} · <code class="mono text-ink">{approval.tool}</code></span>
        <code class="mono min-w-0 flex-1 truncate text-xs text-dim">{approval.args}</code>
        <button
          class="rounded-md bg-ok/20 px-3 py-1 text-xs text-ok hover:bg-ok/30"
          onclick={() => resolveApproval(approval.id, true)}>Allow</button
        >
        <button
          class="rounded-md bg-bad/20 px-3 py-1 text-xs text-bad hover:bg-bad/30"
          onclick={() => resolveApproval(approval.id, false)}>Deny</button
        >
      </div>
    {/each}

    {#if view === "servers"}
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">MCP Servers</h2>
          <p class="mt-0.5 max-w-2xl text-xs text-muted">
            Local executables and remote Streamable HTTP endpoints whose tools are injected into llama-server requests as they pass
            through this bridge.
          </p>
        </div>
        <button
          class="rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-base hover:bg-accent-2"
          onclick={() => {
            dialogTarget = null;
            dialogOpen = true;
          }}>Add MCP Server</button
        >
      </div>

      <div class="mt-4 flex flex-wrap gap-2 text-xs">
        <input
          class="w-64 rounded-lg border border-edge bg-panel px-3 py-1.5 text-ink placeholder:text-dim focus:border-accent focus:outline-none"
          placeholder="Search servers…"
          bind:value={query}
        />
        <select class="rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-muted focus:border-accent focus:outline-none" bind:value={transportFilter}>
          <option value="all">All transports</option>
          <option value="stdio">Local stdio</option>
          <option value="streamable_http">Remote HTTP</option>
        </select>
        <select class="rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-muted focus:border-accent focus:outline-none" bind:value={statusFilter}>
          <option value="all">Any status</option>
          <option value="enabled">Enabled</option>
          <option value="connected">Connected</option>
          <option value="attention">Needs attention</option>
        </select>
      </div>

      <div class="mt-4 grid gap-3">
        {#if state === null}
          <div class="rounded-xl border border-edge bg-panel px-4 py-8 text-center text-sm text-dim">Loading…</div>
        {:else if filtered.length === 0}
          <div class="rounded-xl border border-dashed border-edge-2 bg-panel px-4 py-12 text-center">
            <p class="text-sm text-muted">{servers.length === 0 ? "No MCP servers configured yet." : "No servers match these filters."}</p>
            <button
              class="mt-3 rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-base hover:bg-accent-2"
              onclick={() => {
                dialogTarget = null;
                dialogOpen = true;
              }}>Add MCP Server</button
            >
          </div>
        {:else}
          {#each filtered as server (server.id)}
            <ServerCard
              {server}
              {busy}
              onopen={() => {
                selectedId = server.id;
              }}
              onaction={(kind) => act(server, kind)}
              onedit={() => {
                dialogTarget = server;
                dialogOpen = true;
              }}
            />
          {/each}
        {/if}
      </div>
    {:else if view === "bridge"}
      <BridgeView appState={state} onrefresh={refresh} onflash={flash} />
    {:else}
      <ChatView appState={state} onrefresh={refresh} onflash={flash} />
    {/if}
  </main>

  {#if detail}
    <ServerDetail
      server={detail}
      {busy}
      onclose={() => {
        selectedId = "";
      }}
      onaction={(kind) => detail && act(detail, kind)}
      ontool={patchTool}
      onedit={() => {
        dialogTarget = detail;
        dialogOpen = true;
      }}
    />
  {/if}

  {#if dialogOpen}
    <ServerDialog
      server={dialogTarget}
      onclose={() => {
        dialogOpen = false;
      }}
      onsaved={async (message) => {
        dialogOpen = false;
        await refresh();
        flash(message);
      }}
    />
  {/if}

  {#if toast}
    <div class="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-edge-2 bg-panel-2 px-4 py-2 text-xs text-ink shadow-xl">
      {toast}
    </div>
  {/if}
</div>
