<script lang="ts">
  import type { ToolImagePreview } from "./api.ts";

  interface Props {
    images?: ToolImagePreview[];
    /** Prefix for the saved file name. */
    name?: string;
  }

  let { images, name = "image" }: Props = $props();

  function save(image: ToolImagePreview, index: number): void {
    const ext = (image.mimeType.split("/")[1] ?? "png").replace("jpeg", "jpg");
    const link = document.createElement("a");
    link.href = image.dataUrl;
    link.download = `${(name || "image").replace(/[^A-Za-z0-9_.-]/g, "_")}-${index + 1}.${ext}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
</script>

{#if images?.length}
  <div class="mt-1.5 flex flex-wrap gap-2">
    {#each images as image, index}
      <button
        type="button"
        class="group relative overflow-hidden rounded-lg border border-edge focus:border-accent focus:outline-none"
        title="Click to save"
        onclick={() => save(image, index)}
      >
        <img src={image.dataUrl} alt="" class="h-20 w-auto max-w-52 object-cover" loading="lazy" />
        <span class="absolute inset-x-0 bottom-0 bg-base/85 py-0.5 text-center text-[9px] text-dim group-hover:text-ink">
          save
        </span>
      </button>
    {/each}
  </div>
{/if}
