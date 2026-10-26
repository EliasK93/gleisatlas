import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

const UNBUILT = ["Verbindung planen", "Umstieg prüfen", "So liest man die Zahlen"];

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test("the shell shows title, disclaimer and attribution", async ({ page }) => {
  await page.goto("/muster/heatmap");
  await expect(page.getByRole("banner").getByRole("heading", { name: "Gleisatlas" })).toBeVisible();
  await expect(page).toHaveTitle("Gleisatlas");
  const footer = page.getByRole("contentinfo");
  await expect(footer).toContainText("Historische Statistik, keine Prognose oder Garantie");
  await expect(footer).toContainText("CC BY 4.0");
  await expect(page.getByRole("main")).toBeAttached();
});

test("/ redirects to the map, unknown paths too", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/karte$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wie zuverlässig ist die Bahn?");
  await page.goto("/gibt-es-nicht");
  await expect(page).toHaveURL(/\/karte$/);
});

test("/ and the logo link keep the query string", async ({ page }) => {
  await page.goto("/?g=fern");
  await expect(page).toHaveURL(/\/karte\?g=fern$/);
  await expect(page.getByRole("banner").getByRole("link", { name: "Gleisatlas" })).toHaveAttribute(
    "href",
    "/?g=fern",
  );
});

test("the logo is the wordmark on desktop and the mark alone on mobile", async ({
  page,
  request,
  isMobile,
}) => {
  await page.goto("/muster/heatmap");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  const logo = page.getByRole("banner").getByRole("img", { name: "Gleisatlas" });
  await expect(logo).toBeVisible();
  const shown = isMobile ? "/favicon.svg" : "/logo.svg";
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(shown);
  for (const file of ["/favicon.svg", "/logo.svg"])
    expect((await request.get(file)).headers()["content-type"]).toContain("image/svg+xml");
});

test("a filter change after another key keeps the heatmap page mounted", async ({ page }) => {
  await page.goto("/muster/heatmap?k=median");
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toBeVisible();
  await title.evaluate((el) => (el.dataset.mark = "kept"));
  await page.getByLabel("Gattung:").selectOption("fern");
  await expect(page).toHaveURL(/\/muster\/heatmap\?g=fern&k=median$/);
  await expect(title).toHaveAttribute("data-mark", "kept");
});

test("Inter is loaded", async ({ page }) => {
  await page.goto("/muster/heatmap");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    let face = false;
    document.fonts.forEach((f) => {
      if (f.family.replace(/"/g, "") === "Inter Variable" && f.status === "loaded") face = true;
    });
    return face && document.fonts.check('14px "Inter Variable"');
  });
  expect(loaded).toBe(true);
});

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("sidebar marks the current page and shows unbuilt pages as 'bald'", async ({ page }) => {
    await page.goto("/muster/heatmap?g=fern");
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    const current = nav.getByRole("link", { name: "Wochentag × Uhrzeit" });
    await expect(current).toHaveAttribute("aria-current", "page");
    await expect(current).toHaveAttribute("href", "/muster/heatmap?g=fern");
    await expect(nav.getByRole("link", { name: "Karte" })).toHaveAttribute("href", "/karte?g=fern");
    for (const name of UNBUILT) {
      await expect(nav.getByText(name, { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name })).toHaveCount(0);
    }
    await expect(page.getByText("Datenstand: Sept. 2026 · 5.219 Bahnhöfe")).toBeVisible();
    await expect(page.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/deed.de",
    );
  });
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("tab bar replaces the sidebar, heatmap is transposed, no sideways scroll", async ({
    page,
  }) => {
    await page.goto("/muster/heatmap");
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    await expect(nav).toHaveCount(1);
    await expect(nav.getByRole("link", { name: "Muster" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Mehr" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Karte" })).toHaveAttribute("href", "/karte");
    await expect(nav.getByRole("link", { name: /Planen/ })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Wochentag × Uhrzeit", includeHidden: true }),
    ).toBeHidden();
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("the Muster switch moves between Heatmap, Rankings and Zeitverlauf", async ({ page }) => {
    await page.goto("/muster/heatmap?g=fern");
    const nav = page.getByRole("navigation", { name: "Muster", exact: true });
    const tab = page
      .getByRole("navigation", { name: "Hauptnavigation" })
      .getByRole("link", { name: "Muster" });
    await expect(nav.getByRole("link", { name: "Heatmap" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await nav.getByRole("link", { name: "Rankings" }).click();
    await expect(page).toHaveURL(/\/muster\/rankings\?g=fern$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rankings");
    await expect(nav.getByRole("link", { name: "Rankings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(tab).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Zeitverlauf" }).click();
    await expect(page).toHaveURL(/\/muster\/zeitverlauf\?g=fern$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Zeitverlauf");
    await expect(nav.getByRole("link", { name: "Zeitverlauf" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(tab).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Heatmap" }).click();
    await expect(page).toHaveURL(/\/muster\/heatmap\?g=fern$/);
  });

  test("the Muster tab leads to the heatmap and keeps the filters", async ({ page }) => {
    await page.goto("/karte?g=fern");
    await page
      .getByRole("navigation", { name: "Hauptnavigation" })
      .getByRole("link", { name: "Muster" })
      .click();
    await expect(page).toHaveURL(/\/muster\/heatmap\?g=fern$/);
  });

  test("Mehr lists the remaining pages, the data status and the licence", async ({ page }) => {
    await page.goto("/muster/heatmap");
    await page.getByRole("link", { name: "Mehr" }).click();
    await expect(page).toHaveURL(/\/mehr$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mehr");
    const main = page.getByRole("main");
    await expect(main.getByText("Umstieg prüfen", { exact: true })).toBeVisible();
    await expect(main.getByText("Datenstand: Sept. 2026 · 5.219 Bahnhöfe")).toBeVisible();
    await expect(main.getByRole("link", { name: "CC BY 4.0" })).toBeVisible();
  });
});
