import { expect, test, type Locator, type Page } from "@playwright/test";
import { EMPTY_HEATMAP, heatmapFixture, mockApi } from "./fixtures";

// Scale tokens from theme.css as the browser reports them.
const R1 = "rgb(33, 102, 172)";
const R2 = "rgb(103, 169, 207)";
const R4 = "rgb(239, 138, 71)";
const R5 = "rgb(178, 24, 43)";
const C3 = "rgb(133, 140, 153)";
const C5 = "rgb(54, 60, 71)";
const CANCEL = "rgb(93, 102, 117)";
// The legend entry (with its ✕ swatch), not the cell labels "…: nur Ausfälle (n = 40)".
const LEGEND_ONLY_CANCELLED = /nur Ausfälle$/;

/** Desktop grid: row = weekday (0 = Monday), column = hour; column 24 is "Ø Tag". */
const cell = (page: Page, row: number, col: number) =>
  page.getByRole("table").locator("tbody tr").nth(row).getByRole("cell").nth(col);

test.describe("grid (desktop)", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/heatmap");
  });

  test("7 weekday rows, hatched thin cells, approximate values, day totals", async ({ page }) => {
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(7);
    await expect(cell(page, 0, 3)).toContainText("Montag 3–4 Uhr: Zu wenig Fahrten (n = 9)");
    await expect(cell(page, 6, 3)).toContainText("Zu wenig Fahrten (n = 0)");
    await expect(cell(page, 0, 5)).toContainText("Montag 5–6 Uhr: ~75 % pünktlich, n = 30");
    await expect(cell(page, 1, 7)).toContainText("Dienstag 7–8 Uhr: 75 % pünktlich, n = 1.240");
    await expect(cell(page, 0, 24)).toHaveText("81 %");
    await expect(page.getByText("n = 203.000 Halte · Sept. 2026")).toBeVisible();
  });

  test("boundary values land in the right class; the metric switch sets k", async ({ page }) => {
    await expect(cell(page, 0, 0)).toHaveCSS("background-color", R1);
    await expect(cell(page, 0, 0)).toContainText("90 % pünktlich");
    await expect(cell(page, 0, 1)).toHaveCSS("background-color", R2);
    await expect(cell(page, 0, 2)).toHaveCSS("background-color", R5);
    await page.getByRole("button", { name: "Typische Verspätung" }).click();
    await expect(page).toHaveURL(/[?&]k=median/);
    await expect(page.getByRole("button", { name: "Typische Verspätung" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(cell(page, 0, 4)).toHaveCSS("background-color", R2);
    await expect(cell(page, 0, 4)).toContainText("typisch 1 min verspätet");
  });

  test("the class follows the shown, rounded value; 60 % is class 4", async ({ page }) => {
    await expect(cell(page, 0, 6)).toContainText("89 % pünktlich");
    await expect(cell(page, 0, 6)).toHaveCSS("background-color", R2);
    await expect(cell(page, 0, 7)).toContainText("90 % pünktlich");
    await expect(cell(page, 0, 7)).toHaveCSS("background-color", R1);
    await expect(cell(page, 0, 9)).toContainText("60 % pünktlich");
    await expect(cell(page, 0, 9)).toHaveCSS("background-color", R4);
  });

  test("only-cancelled cells have their own look and are not thin", async ({ page }) => {
    const only = cell(page, 0, 8);
    await expect(only).toHaveCSS("background-color", CANCEL);
    await expect(only).toContainText("Montag 8–9 Uhr: nur Ausfälle (n = 40)");
    await expect(only).toContainText("✕");
    await only.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Montag 8–9 Uhr: nur Ausfälle (n = 40)");
    await expect(page.getByText(LEGEND_ONLY_CANCELLED)).toBeVisible();
  });

  test("delay metrics gate on arrived stops, Ausfälle on all stops", async ({ page }) => {
    await expect(cell(page, 0, 10)).toContainText("Montag 10–11 Uhr: Zu wenig Fahrten (n = 20)");
    await expect(cell(page, 0, 11)).toContainText("Montag 11–12 Uhr: ~75 % pünktlich, n = 60");
    await page.getByRole("button", { name: "Ausfälle" }).click();
    await expect(cell(page, 0, 10)).toContainText("~50,0 % ausgefallen, n = 20");
    await expect(cell(page, 0, 11)).toContainText("Montag 11–12 Uhr: 50,0 % ausgefallen, n = 60");
    await expect(cell(page, 1, 0)).toHaveCSS("background-color", C3);
    await expect(cell(page, 0, 8)).toHaveCSS("background-color", C5);
    await expect(page.getByText(LEGEND_ONLY_CANCELLED)).toHaveCount(0);
  });

  test("tooltip on hover and values as a table", async ({ page }) => {
    await cell(page, 0, 0).hover();
    await expect(page.getByRole("tooltip")).toContainText("Montag 0–1 Uhr: 90 % pünktlich");
    const toggle = page.getByRole("button", { name: "Als Tabelle anzeigen" });
    await expect(cell(page, 0, 0).getByText("90 %", { exact: true })).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(cell(page, 0, 0).getByText("90 %", { exact: true })).toBeVisible();
  });

  test("Auf einen Blick names the worst and best slot and the thin cells", async ({ page }) => {
    const card = page.getByRole("region", { name: "Auf einen Blick" });
    await expect(card).toContainText("Am unzuverlässigsten: Montag 2–3 Uhr · 59 % pünktlich");
    await expect(card).toContainText("Am zuverlässigsten: Montag 0–1 Uhr · 90 % pünktlich");
    await expect(card.locator("b", { hasText: "59 %" })).toBeVisible();
    await expect(card).toContainText("3 Felder haben zu wenige Fahrten für eine Aussage.");
  });
});

test.describe("grid (mobile)", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/heatmap");
  });

  test("transposed grid keeps the hidden cell labels and has a Ø row", async ({ page }) => {
    const table = page.getByRole("table");
    await expect(table.locator("tbody tr").nth(3).getByRole("cell").first()).toContainText(
      "Montag 3–4 Uhr: Zu wenig Fahrten (n = 9)",
    );
    await expect(table.locator("tfoot tr").getByRole("rowheader")).toHaveText("Ø");
    await expect(table.locator("tfoot td").first()).toHaveText("81 %");
  });

  test("the tooltip clears on scroll and on a tap outside the grid", async ({ page }) => {
    const first = page.getByRole("table").locator("tbody td").first();
    const tip = page.getByRole("tooltip");
    await first.tap();
    await expect(tip).toBeVisible();
    await page.evaluate(() => scrollBy(0, 100));
    await expect(tip).toHaveCount(0);
    await first.tap();
    await expect(tip).toBeVisible();
    await page.getByRole("heading", { level: 1 }).tap();
    await expect(tip).toHaveCount(0);
  });

  test("small controls have a hit area of at least 44 px", async ({ page }) => {
    /** True when a tap 21 px above and below the centre still lands on the control. */
    const tall = (l: Locator) =>
      l.evaluate((el) => {
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return [-21, 21].every((dy) => el.contains(document.elementFromPoint(x, y + dy)));
      });
    const controls = [
      page.locator("label").filter({ hasText: "Gattung" }),
      page.getByRole("button", { name: /^Bahnhof/ }),
      page.getByRole("button", { name: "Zurücksetzen", exact: true }),
      page.getByRole("button", { name: "Teilen" }),
      page.getByRole("button", { name: "Als Tabelle anzeigen" }),
      ...["Pünktlichkeit", "Typische Verspätung", "Schlechteste 10 %", "Ausfälle"].map((name) =>
        page.getByRole("button", { name, exact: true }),
      ),
    ];
    for (const c of controls) expect(await tall(c), `${await c.textContent()}`).toBe(true);
  });
});

test("Gattung sets g and requests gattung=fern", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/muster/heatmap");
  await page.getByLabel("Gattung").selectOption("fern");
  await expect(page).toHaveURL(/[?&]g=fern/);
  await expect
    .poll(() =>
      requests.some((u) => u.pathname === "/heatmap" && u.searchParams.get("gattung") === "fern"),
    )
    .toBe(true);
});

test("Bahnhof sets bhf and the chip keeps the name after a reload", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/muster/heatmap");
  await page.getByRole("button", { name: /^Bahnhof/ }).click();
  await page.getByRole("combobox", { name: "Bahnhof suchen" }).fill("köln");
  await page.getByRole("option", { name: /Köln Hbf/ }).click();
  await expect(page).toHaveURL(/[?&]bhf=8000207/);
  await expect(page.getByRole("button", { name: /^Bahnhof/ })).toContainText("Köln Hbf");
  await page.reload();
  await expect(page.getByRole("button", { name: /^Bahnhof/ })).toContainText("Köln Hbf");
  expect(requests.some((u) => u.pathname === "/stationen/8000207")).toBe(true);
  expect(requests.some((u) => u.searchParams.get("eva") === "8000207")).toBe(true);
});

test("the station popover closes when focus tabs out of it", async ({ page }) => {
  await mockApi(page);
  await page.goto("/muster/heatmap");
  await page.getByRole("button", { name: /^Bahnhof/ }).click();
  const search = page.getByRole("combobox", { name: "Bahnhof suchen" });
  await expect(search).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(search).toBeHidden();
});

test("Zurücksetzen clears all filters", async ({ page }) => {
  await mockApi(page);
  await page.goto("/muster/heatmap?g=fern&bhf=8000207&k=median");
  await page.getByRole("button", { name: "Zurücksetzen" }).click();
  await expect(page).toHaveURL(/\/muster\/heatmap$/);
  await expect(page.getByLabel("Gattung")).toHaveValue("");
});

test("Teilen copies the link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page);
  await page.goto("/muster/heatmap?g=fern");
  await page.getByRole("button", { name: "Teilen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link kopiert" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/g=fern$/);
});

test("invalid URL values are dropped, so Teilen never copies them", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page);
  await page.goto("/muster/heatmap?g=xyz&k=median&von=2026-9");
  await expect(page).toHaveURL(/\/muster\/heatmap\?k=median$/);
  await page.getByRole("button", { name: "Teilen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link kopiert" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\?k=median$/);
});

test("empty state offers a reset", async ({ page }) => {
  await mockApi(page, () => EMPTY_HEATMAP);
  await page.goto("/muster/heatmap?g=fern");
  await expect(page.getByText("Für diese Filter gibt es keine Fahrten")).toBeVisible();
  await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
  await expect(page).toHaveURL(/\/muster\/heatmap$/);
});

test("error state keeps the filters and recovers on retry", async ({ page }) => {
  let calls = 0;
  await mockApi(page, () => (calls++ === 0 ? null : heatmapFixture()));
  await page.goto("/muster/heatmap?g=fern");
  await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page).toHaveURL(/[?&]g=fern/);
});

test("after 5 seconds the skeleton says the server is starting, and counts the seconds", async ({
  page,
}) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/heatmap",
    () => new Promise(() => {}),
  );
  await page.clock.install();
  await page.goto("/muster/heatmap");
  const hint = page.getByText(/Der Server startet gerade \(\d+ s\)/);
  await page.clock.fastForward(4000);
  await expect(hint).toHaveCount(0);
  await page.clock.fastForward(1500);
  await expect(hint).toContainText(/\([56] s\), das kann bis zu einer Minute dauern\./);
  await page.clock.fastForward(3000);
  await expect(hint).toContainText(/\((8|9|10) s\)/);
});
