import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tauri prints Rust errors to the same terminal; keep them on screen.
  clearScreen: false,
  server: {
    // `tauri dev` loads exactly this port (devUrl in src-tauri/tauri.conf.json).
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
