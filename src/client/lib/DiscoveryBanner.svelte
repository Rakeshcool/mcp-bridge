<script lang="ts">
  interface Props {
    pending: number;
    lastScanAt: string | null;
    onreview: () => void;
  }

  let { pending, lastScanAt, onreview }: Props = $props();
</script>

{#if pending > 0}
  <div class="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
    <span class="font-medium text-warn">{pending} application{pending === 1 ? "" : "s"} waiting for approval</span>
    <span class="text-[11px] text-muted">
      Discovery found an application that can expose tools{lastScanAt ? ` (last scan ${new Date(lastScanAt).toLocaleTimeString()})` : ""}. Discovery
      does not grant permission to run anything.
    </span>
    <button class="ml-auto rounded-md bg-warn/20 px-3 py-1 text-xs text-warn hover:bg-warn/30" onclick={onreview}>Review</button>
  </div>
{/if}
