import { defineConfig, devices } from "@playwright/test";

// Worktrees run side by side, so the port comes from the environment
// (docs/guideline/base/08-shared-resources.md); strictPort makes a clash fail loudly.
const port = Number(process.env.TOTE_E2E_PORT ?? 1430);

export default defineConfig({
  testDir: "tests/e2e",
  // WebKit is the engine closest to the app's WKWebView.
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
