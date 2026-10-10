import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

import { defineConfig, type Plugin } from "vitest/config";

const EXTENSIONS_DIR = resolve(__dirname, "src-tauri/resources/extensions");
// As the app types them (`content_type` in src-tauri/src/extensions/serve.rs).
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Serves the bundled extensions at /extensions/<id>/<path> on the dev server only — the same
 * files the app serves at tote-ext://localhost/<id>/<path> — so the browser preview and the UI
 * tests load the real viewer pages. Not part of the build: the app reads them as resources. */
function serveExtensions(): Plugin {
  return {
    name: "tote-serve-extensions",
    configureServer(server) {
      server.middlewares.use("/extensions", (req, res) => {
        let relative: string;
        try {
          relative = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
        } catch {
          res.statusCode = 404;
          res.end();
          return;
        }
        const file = join(EXTENSIONS_DIR, relative);
        if (
          !file.startsWith(EXTENSIONS_DIR + "/") ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const ext = file.slice(file.lastIndexOf("."));
        res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Tauri prints Rust errors to the same terminal; keep them on screen.
  clearScreen: false,
  plugins: [serveExtensions()],
  server: {
    // `tauri dev` loads exactly this port (devUrl in src-tauri/tauri.conf.json).
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});
