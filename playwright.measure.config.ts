import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.TOTE_E2E_PORT ?? 1430);

/** The long-line measurement (Task 14 of the extensions-and-screens plan): one worker, no
 * retries, a long timeout — the point is the numbers, not a pass. */
export default defineConfig({
  testDir: "tests/measure",
  timeout: 20 * 60 * 1000,
  retries: 0,
  workers: 1,
  reporter: "list",
  projects: [
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], headless: !process.env.TOTE_MEASURE_HEADED },
    },
  ],
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
