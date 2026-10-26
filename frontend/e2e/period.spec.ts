import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./fixtures";

const von = (page: Page) => page.getByLabel("Zeitraum von");
const bis = (page: Page) => page.getByLabel("Zeitraum bis");

test("the selects offer the months of /datenstand and default to the covered range", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/muster/heatmap");
  await expect(von(page)).toHaveValue("2025-11");
  await expect(bis(page)).toHaveValue("2026-09");
  await expect(von(page).locator("option")).toHaveCount(12);
  await expect(von(page).locator("option").first()).toHaveText("Okt. 2025");
  await expect(page).toHaveURL(/\/muster\/heatmap$/);
});

test("picking von and bis writes them to the URL and the next request carries them", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/muster/heatmap");
  await von(page).selectOption("2026-03");
  await expect(page).toHaveURL(/\/muster\/heatmap\?von=2026-03$/);
  await bis(page).selectOption("2026-06");
  await expect(page).toHaveURL(/\/muster\/heatmap\?von=2026-03&bis=2026-06$/);
  await expect
    .poll(() =>
      requests.some(
        (u) =>
          u.pathname === "/heatmap" &&
          u.searchParams.get("von") === "2026-03" &&
          u.searchParams.get("bis") === "2026-06",
      ),
    )
    .toBe(true);
  await expect(von(page)).toHaveValue("2026-03");
  await expect(bis(page)).toHaveValue("2026-06");
});

test("a von after bis moves bis, a bis before von moves von", async ({ page }) => {
  await mockApi(page);
  await page.goto("/muster/heatmap?von=2026-03&bis=2026-05");
  await von(page).selectOption("2026-08");
  await expect(page).toHaveURL(/\?von=2026-08&bis=2026-08$/);
  await bis(page).selectOption("2026-01");
  await expect(page).toHaveURL(/\?von=2026-01&bis=2026-01$/);
  await expect(von(page)).toHaveValue("2026-01");
  await expect(bis(page)).toHaveValue("2026-01");
});

test("the period works on the map and the station page and keeps other filters", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/karte?g=fern");
  await von(page).selectOption("2026-02");
  await expect(page).toHaveURL(/\/karte\?g=fern&von=2026-02$/);
  await page.goto("/bahnhof/8000207?bis=2026-04");
  await expect(bis(page)).toHaveValue("2026-04");
  await von(page).selectOption("2026-01");
  await expect(page).toHaveURL(/\?von=2026-01&bis=2026-04$/);
});

test("Zurücksetzen removes von and bis", async ({ page }) => {
  await mockApi(page);
  await page.goto("/muster/heatmap?von=2026-03&bis=2026-05");
  await page.getByRole("button", { name: "Zurücksetzen" }).click();
  await expect(page).toHaveURL(/\/muster\/heatmap$/);
  await expect(von(page)).toHaveValue("2025-11");
  await expect(bis(page)).toHaveValue("2026-09");
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("both selects fit 375 px and have a hit area of at least 44 px", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/heatmap");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const select of [von(page), bis(page)]) {
      const tap = select.locator("xpath=..");
      /** True when a tap 21 px above and below the centre still lands on the control. */
      const tall = await tap.evaluate((el) => {
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return [-21, 21].every((dy) => el.contains(document.elementFromPoint(x, y + dy)));
      });
      expect(tall).toBe(true);
    }
  });
});
