import { expect, test, type Page } from "@playwright/test";
import swa from "../public/staticwebapp.config.json" with { type: "json" };
import { mockApi } from "./fixtures";

// Runs against the production build served with the headers of staticwebapp.config.json
// (the "csp" project), so a wrong hash or a missing directive shows up here, not on Azure.

const PAGES = [
  { name: "map", path: "/karte", ready: (page: Page) => page.getByTestId("map") },
  { name: "station page", path: "/bahnhof/8000207" },
  { name: "heatmap", path: "/muster/heatmap" },
  { name: "time series", path: "/muster/zeitverlauf" },
  { name: "Impressum", path: "/impressum" },
  { name: "Datenschutz", path: "/datenschutz" },
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    for (const { name, path, ready } of PAGES) {
      test(`${name} runs without a CSP violation or a console error`, async ({ page }) => {
        const problems: string[] = [];
        await page.addInitScript(() =>
          document.addEventListener("securitypolicyviolation", (e) =>
            console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
          ),
        );
        page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
        page.on("pageerror", (e) => problems.push(e.message));
        await mockApi(page);
        await page.emulateMedia({ colorScheme: scheme });
        const response = await page.goto(path);
        // Without the header every check below would pass vacuously.
        expect(response?.headers()["content-security-policy"]).toBe(
          swa.globalHeaders["Content-Security-Policy"],
        );
        // The theme script is inline: the hash in the policy has to allow it, or the page logs a violation.
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        if (ready) await expect(ready(page)).toHaveAttribute("data-ready", "true");
        // Give a late violation (a font, a worker, a tile) time to report.
        await page.waitForTimeout(500);
        expect(problems).toEqual([]);
      });
    }
  });
}

// The e2e build has no provider details, like the deployed site until they are filled in.
test("without provider details the Impressum says they follow", async ({ page }) => {
  await mockApi(page);
  await page.goto("/impressum");
  const main = page.getByRole("main");
  await expect(main).toContainText("Angaben folgen.");
  await expect(main.getByRole("link")).toHaveCount(0);
});
