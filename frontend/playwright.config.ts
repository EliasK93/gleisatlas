import { defineConfig, devices } from "@playwright/test";

// The config runs in Node, but the project has no Node types; this is the one global it reads.
declare const process: { env: Record<string, string> };

const PREVIEW = "http://localhost:4317";
// Not the dev port 5317: a dev server left running there (for example one under the debugger)
// would serve the tests and slow them down, so the suite always starts its own.
const DEV = "http://localhost:5318";

export default defineConfig({
  testDir: "e2e",
  // The JUnit file feeds the README's tests badge in CI (scripts/tests_badge.py).
  reporter: [["list"], ["junit", { outputFile: "test-results/junit.xml" }]],
  // The map's data-ready can take longer than the default 5 s when every worker draws a map at
  // once. Waits return as soon as they pass, so this costs time only on a real failure.
  expect: { timeout: 15_000 },
  // Playwright defaults to en-US; the German UI is the default for the existing specs. `locale`
  // only emulates the page's language: a native date field takes its field order from the
  // browser's own language, so typed dates stay DD.MM.YYYY only with a German browser. Chromium
  // reads that from `--lang` on Windows and macOS and from `LANGUAGE` on Linux.
  use: {
    baseURL: DEV,
    locale: "de-DE",
    launchOptions: { args: ["--lang=de-DE"], env: { ...process.env, LANGUAGE: "de" } },
  },
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
      command: "npm run dev -- --port 5318",
      url: DEV,
      reuseExistingServer: false,
    },
    {
      command:
        "npm run build -- --mode e2e --outDir dist-e2e && npx vite preview --outDir dist-e2e",
      url: PREVIEW,
      timeout: 180_000,
      // A production build without provider details (no .env file for this mode), like the
      // deployed site before the Impressum is filled in; a reused server could serve a stale build.
      reuseExistingServer: false,
      env: { VITE_API_URL: "https://api.e2e.swedencentral.azurecontainerapps.io" },
    },
  ],
});
