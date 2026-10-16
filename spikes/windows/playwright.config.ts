import { defineConfig, devices } from "@playwright/test";

// Same port rule as the root config (docs/guideline/base/08-shared-resources.md). The probe page is
// served from this directory alone, so "/" is probe/index.html and `window.open("/?window=ws-2")` resolves.
const port = Number(process.env.TOTE_E2E_PORT ?? 1430);

export default defineConfig({
  testDir: ".",
  testMatch: "probe.spec.ts",
  // WebKit is the engine closest to the app's WKWebView.
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    // Playwright starts the server in this config's directory, where pnpm cannot find the root's vite.
    command: `cd ../.. && pnpm exec vite spikes/windows --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
