<script lang="ts">
  import { call } from "./api.ts";
  import type { ActivityRecord, AppState, ToolCallRecord, ToolImagePreview } from "./api.ts";
  import ToolImages from "./ToolImages.svelte";

  interface Props {
    appState: AppState | null;
    onrefresh: () => Promise<void>;
    onflash: (text: string) => void;
  }

  interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    toolCalls: ToolCallRecord[];
    pending: boolean;
    error: boolean;
  }

  let { appState, onrefresh, onflash }: Props = $props();

  let mode = $state<"model" | "direct">("model");
  let model = $state("");
  let messages = $state<ChatMessage[]>([]);
  let input = $state("");
  let busy = $state(false);
  let controller = $state<AbortController | null>(null);
  let toolName = $state("");
  let toolArgs = $state("{}");

  const models = $derived(appState?.upstream.models ?? []);
  const tools = $derived(
    (appState?.catalog ?? []) as Array<{ exposedName: string; toolName: string; serverName: string; permission: string; description: string }>,
  );
  const selectedTool = $derived(tools.find((tool) => tool.exposedName === toolName) ?? null);
  const upstreamDown = $derived(appState !== null && !appState.upstream.reachable);

  const field = "w-full rounded-lg border border-edge bg-base px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none";

  function push(message: ChatMessage): number {
    messages = [...messages, message];
    return messages.length - 1;
  }

  function scrollToEnd(): void {
    requestAnimationFrame(() => {
      const element = document.getElementById("chat-scroll");
      if (element) element.scrollTop = element.scrollHeight;
    });
  }

  async function sendModel(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    push({ role: "user", content: text, toolCalls: [], pending: false, error: false });
    const history = messages
      .filter((message) => message.content.trim().length > 0)
      .map((message) => ({ role: message.role, content: message.content }));
    const index = push({ role: "assistant", content: "", toolCalls: [], pending: true, error: false });
    input = "";
    busy = true;
    controller = new AbortController();
    let activityId = "";
    scrollToEnd();

    try {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history, stream: true, ...(model ? { model } : {}) }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const raw = await response.text();
        let message = `HTTP ${response.status}`;
        try {
          message = JSON.parse(raw)?.error?.message ?? message;
        } catch {
          // keep HTTP status
        }
        messages[index].content = message;
        messages[index].error = true;
        messages = [...messages];
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((entry) => entry.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            messages[index].content += delta;
            messages = [...messages];
            scrollToEnd();
          }
          if (chunk?.x_mcp_bridge?.activity_id) activityId = String(chunk.x_mcp_bridge.activity_id);
        }
      }
    } catch (error) {
      const aborted = (error as Error).name === "AbortError";
      messages[index].content = aborted ? messages[index].content || "Stopped." : `Error: ${(error as Error).message}`;
      messages[index].error = !aborted;
      messages = [...messages];
    } finally {
      messages[index].pending = false;
      messages = [...messages];
      busy = false;
      controller = null;
      if (activityId) {
        try {
          const result: any = await call("/api/activity");
          const record = (result.activity as ActivityRecord[]).find((entry) => entry.id === activityId);
          if (record) {
            messages[index].toolCalls = record.rounds.flatMap((round) => round.toolCalls);
            messages = [...messages];
          }
        } catch {
          // activity is informative only
        }
      }
      scrollToEnd();
      void onrefresh();
    }
  }

  async function runDirect(): Promise<void> {
    if (busy || !toolName) return;
    let parsed: unknown = {};
    const rawArgs = toolArgs.trim();
    if (rawArgs) {
      try {
        parsed = JSON.parse(rawArgs);
      } catch (error) {
        onflash(`Arguments must be valid JSON: ${(error as Error).message}`);
        return;
      }
    }
    push({ role: "user", content: `${toolName} ${rawArgs || "{}"}`, toolCalls: [], pending: false, error: false });
    const index = push({ role: "assistant", content: "Running tool…", toolCalls: [], pending: true, error: false });
    busy = true;
    scrollToEnd();
    try {
      const result: any = await call(`/api/tools/${encodeURIComponent(toolName)}/call`, { method: "POST", body: { arguments: parsed } });
      messages[index].content = result.isError ? "The tool reported an error." : "Tool result";
      messages[index].toolCalls = [
        {
          name: toolName,
          serverId: String(result.serverId ?? ""),
          toolName: String(result.toolName ?? ""),
          args: rawArgs || "{}",
          permission: "allow",
          status: result.isError ? "error" : "ok",
          durationMs: Number(result.durationMs ?? 0),
          result: String(result.result ?? ""),
          ...(result.images?.length ? { images: result.images as ToolImagePreview[] } : {}),
        },
      ];
      messages = [...messages];
    } catch (error) {
      messages[index].content = (error as Error).message;
      messages[index].error = true;
      messages = [...messages];
    } finally {
      messages[index].pending = false;
      messages = [...messages];
      busy = false;
      scrollToEnd();
    }
  }

  function submit(): void {
    if (mode === "model") void sendModel();
    else void runDirect();
  }
</script>

<div class="flex h-[calc(100vh-9.5rem)] flex-col rounded-xl border border-edge bg-panel">
  <header class="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-2.5">
    <div class="flex gap-1 rounded-lg border border-edge bg-panel-2 p-0.5 text-xs">
      <button
        class={mode === "model" ? "rounded-md bg-edge px-3 py-1 text-ink" : "rounded-md px-3 py-1 text-muted hover:text-ink"}
        onclick={() => (mode = "model")}>Local model</button
      >
      <button
        class={mode === "direct" ? "rounded-md bg-edge px-3 py-1 text-ink" : "rounded-md px-3 py-1 text-muted hover:text-ink"}
        onclick={() => (mode = "direct")}>Direct tool</button
      >
    </div>

    {#if mode === "model"}
      <label class="flex items-center gap-2 text-xs text-dim">
        model
        <select class="rounded-lg border border-edge bg-base px-2 py-1 text-xs text-ink" bind:value={model}>
          <option value="">server default</option>
          {#each models as entry}
            <option value={entry}>{entry}</option>
          {/each}
        </select>
      </label>
    {:else}
      <label class="flex min-w-0 items-center gap-2 text-xs text-dim">
        tool
        <select class="max-w-72 rounded-lg border border-edge bg-base px-2 py-1 text-xs text-ink" bind:value={toolName}>
          <option value="">choose a tool…</option>
          {#each tools as entry}
            <option value={entry.exposedName}>{entry.exposedName}</option>
          {/each}
        </select>
      </label>
    {/if}

    <span class="ml-auto text-[11px] text-dim">
      {#if mode === "model"}
        {appState?.upstream.reachable ? `llama-server up · ${appState?.upstream.model ?? ""}` : "llama-server unreachable"}
      {:else}
        runs the MCP tool directly — no model
      {/if}
    </span>
    <button class="text-[11px] text-dim hover:text-ink" onclick={() => (messages = [])}>clear</button>
  </header>

  {#if mode === "model" && upstreamDown}
    <div class="border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
      llama-server is not reachable at {appState?.upstream.baseUrl}. Start it, then reload — direct tool calls still work.
    </div>
  {/if}

  <div id="chat-scroll" class="flex-1 space-y-3 overflow-y-auto px-4 py-4">
    {#if messages.length === 0}
      <div class="rounded-xl border border-dashed border-edge-2 px-4 py-10 text-center text-sm text-dim">
        {#if mode === "model"}
          Ask something that needs a tool — what works depends on the servers you connected
        {:else}
          Pick a tool and pass its arguments as JSON, for example <code class="mono">{ "{}" }</code>.
        {/if}
      </div>
    {/if}

    {#each messages as message}
      <div class={message.role === "user" ? "flex justify-end" : ""}>
        <div class={message.role === "user" ? "max-w-[85%] rounded-xl bg-accent/15 px-3.5 py-2.5 text-sm" : "w-full max-w-[92%] text-sm"}>
          {#if message.role === "assistant"}
            <div class="rounded-xl border border-edge bg-panel-2 px-3.5 py-2.5">
              {#if message.pending && !message.content}
                <p class="text-xs text-dim">working…</p>
              {:else}
                <p class="whitespace-pre-wrap text-ink {message.error ? 'text-bad' : ''}">{message.content}</p>
              {/if}

              {#if message.toolCalls.length}
                <ul class="mt-2 space-y-1.5">
                  {#each message.toolCalls as toolCall}
                    <li class="rounded-lg bg-base px-2.5 py-2">
                      <div class="mono flex flex-wrap items-center gap-2 text-[11px]">
                        <span
                          class={toolCall.status === "ok"
                            ? "text-ok"
                            : toolCall.status === "denied" || toolCall.status === "skipped"
                              ? "text-warn"
                              : "text-bad"}>{toolCall.status}</span
                        >
                        <span class="text-ink">{toolCall.toolName || toolCall.name}</span>
                        <span class="text-dim">{toolCall.durationMs}ms</span>
                        <span class="text-dim">{toolCall.permission}</span>
                      </div>
                      {#if toolCall.args && toolCall.args !== "{}"}
                        <p class="mono mt-1 break-all text-[10px] text-dim">{toolCall.args}</p>
                      {/if}
                      <p class="mono mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[10px] text-muted">{toolCall.result}</p>
                      <ToolImages images={toolCall.images} name={toolCall.toolName || toolCall.name} />
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {:else}
            <p class="whitespace-pre-wrap">{message.content}</p>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <footer class="border-t border-edge px-4 py-3">
    {#if mode === "direct"}
      <label class="mb-2 block text-[11px] uppercase tracking-wide text-dim">
        arguments (JSON){#if selectedTool}<span class="ml-2 normal-case text-muted">{selectedTool.description.slice(0, 110)}</span>{/if}
      </label>
      <textarea class="{field} mono mb-2" rows="2" bind:value={toolArgs} spellcheck="false"></textarea>
    {/if}
    <div class="flex items-end gap-2">
      <textarea
        class={field}
        rows="2"
        bind:value={input}
        placeholder={mode === "model" ? "Message the local model…" : "Press Run to call the selected tool"}
        disabled={mode === "direct"}
        onkeydown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && mode === "model") {
            event.preventDefault();
            void sendModel();
          }
        }}
      ></textarea>
      {#if busy && controller}
        <button
          class="rounded-lg border border-edge px-3.5 py-2 text-xs text-muted hover:text-ink"
          onclick={() => {
            controller?.abort();
          }}>Stop</button
        >
      {/if}
      <button
        class="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-base hover:bg-accent-2 disabled:opacity-50"
        onclick={submit}
        disabled={busy || (mode === "model" ? !input.trim() : !toolName)}
      >
        {busy ? "…" : mode === "model" ? "Send" : "Run"}
      </button>
    </div>
  </footer>
</div>
