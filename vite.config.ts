import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/client", import.meta.url)),
  // Serve the project's image assets (logo) at /logo.png, in dev and in the build.
  publicDir: fileURLToPath(new URL("./assets", import.meta.url)),
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:7800",
      "/v1": "http://127.0.0.1:7800",
      "/props": "http://127.0.0.1:7800",
      "/health": "http://127.0.0.1:7800",
    },
  },
});
