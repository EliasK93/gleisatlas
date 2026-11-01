import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

// The four metrics are the same on every page: one switch, one explanation line under it, one `k`.
const PAGES = [
  "/karte",
  "/lage?tag=2026-09-15",
  "/muster/heatmap",
  "/muster/rankings",
  "/muster/zeitverlauf",
  "/bahnhof/8000207",
];

const DE = [
  [
    "Pünktlichkeit",
    "Anteil der Ankünfte weniger als 6 Minuten nach Plan (DB-Definition). Ausgefallene Halte zählen nicht mit.",
  ],
  [
    "Typische Verspätung",
    "Median: Die Hälfte der Ankünfte ist weniger verspätet, die andere Hälfte mehr.",
  ],
  [
    "Schlechteste 10 %",
    "Die verspätetsten 10 % der Ankünfte sind mindestens so spät (90. Perzentil, P90).",
  ],
  ["Ausfälle", "Anteil der Halte, die ausfallen. Sie zählen nie als Verspätung."],
] as const;

test.describe("the explanation line under the metric switch", () => {
  for (const path of PAGES)
    test(`${path} describes the selected metric and follows the selection`, async ({ page }) => {
      await mockApi(page);
      await page.goto(path);
      const group = page.getByRole("group", { name: "Kennzahl" });
      await expect(group).toHaveAccessibleDescription(DE[0][1]);
      for (const [button, help] of DE.slice(1)) {
        await group.getByRole("button", { name: button, exact: true }).click();
        await expect(group).toHaveAccessibleDescription(help);
      }
      await group.getByRole("button", { name: "Pünktlichkeit", exact: true }).click();
      await expect(group).toHaveAccessibleDescription(DE[0][1]);
    });

  test.describe("English", () => {
    test.use({ locale: "en-US" });

    test("the P90 button has a plain name and the line spells P90 out", async ({ page }) => {
      await mockApi(page);
      await page.goto("/muster/heatmap");
      const group = page.getByRole("group", { name: "Metric" });
      await group.getByRole("button", { name: "Worst 10%", exact: true }).click();
      await expect(page).toHaveURL(/[?&]k=p90/);
      await expect(group).toHaveAccessibleDescription(
        "The latest 10% of arrivals are at least this late (90th percentile, P90).",
      );
      await group.getByRole("button", { name: "Cancellations", exact: true }).click();
      await expect(group).toHaveAccessibleDescription(
        "Share of stops that are cancelled. They never count as delay.",
      );
    });
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  // The floating card of the map pages would grow by about 40 px: it keeps the line to the screen
  // readers only.
  for (const path of ["/karte", "/lage?tag=2026-09-15"])
    test(`${path} hides the line but the switch is still described by it`, async ({ page }) => {
      await mockApi(page);
      await page.goto(path);
      await expect(page.getByRole("group", { name: "Kennzahl" })).toHaveAccessibleDescription(
        DE[0][1],
      );
      await expect(page.getByText(DE[0][1], { exact: true })).toBeHidden();
    });

  test("the heatmap shows the line", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/heatmap");
    await expect(page.getByText(DE[0][1], { exact: true })).toBeVisible();
  });
});

for (const k of ["ausfall", "p90"])
  test(`k=${k} survives Karte, Zeitverlauf and back through the navigation`, async ({
    page,
    isMobile,
  }) => {
    await mockApi(page);
    await page.goto(`/karte?k=${k}`);
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    if (isMobile) {
      await nav.getByRole("link", { name: "Muster" }).click();
      await page
        .getByRole("navigation", { name: "Muster", exact: true })
        .getByRole("link", { name: "Zeitverlauf" })
        .click();
    } else await nav.getByRole("link", { name: "Zeitverlauf" }).click();
    await expect(page).toHaveURL(new RegExp(`/muster/zeitverlauf\\?k=${k}$`));
    await expect(
      page.getByRole("group", { name: "Kennzahl" }).locator('[aria-pressed="true"]'),
    ).toHaveText(k === "ausfall" ? "Ausfälle" : "Schlechteste 10 %");
    await nav.getByRole("link", { name: "Karte" }).click();
    await expect(page).toHaveURL(new RegExp(`/karte\\?k=${k}$`));
  });
