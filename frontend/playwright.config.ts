import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // The JUnit file feeds the README's tests badge in CI (scripts/tests_badge.py).
  reporter: [["list"], ["junit", { outputFile: "test-results/junit.xml" }]],
  // Playwright defaults to en-US; the German UI is the default for the existing specs.
  use: { baseURL: "http://localhost:5173", locale: "de-DE" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: true,
  },
});
