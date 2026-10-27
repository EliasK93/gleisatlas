import { defineConfig, devices } from "@playwright/test";

const PREVIEW = "http://localhost:4173";

export default defineConfig({
  testDir: "e2e",
  // The JUnit file feeds the README's tests badge in CI (scripts/tests_badge.py).
  reporter: [["list"], ["junit", { outputFile: "test-results/junit.xml" }]],
  // Playwright defaults to en-US; the German UI is the default for the existing specs.
  use: { baseURL: "http://localhost:5173", locale: "de-DE" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: "csp.spec.ts" },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testIgnore: "csp.spec.ts" },
    // The production build behind the headers of the deployed site (staticwebapp.config.json).
    {
      name: "csp",
      use: { ...devices["Desktop Chrome"], baseURL: PREVIEW },
      testMatch: "csp.spec.ts",
    },
  ],
  webServer: [
    {
      command: "npm run dev -- --port 5173 --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: true,
    },
    {
      command:
        "npm run build -- --mode development --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4173 --strictPort",
      url: PREVIEW,
      timeout: 180_000,
      // A production build with the dummy provider details of .env.development;
      // a reused server could serve a stale build.
      reuseExistingServer: false,
      env: { VITE_API_URL: "https://api.e2e.westeurope.azurecontainerapps.io" },
    },
  ],
});
