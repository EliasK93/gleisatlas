import { expect, test, type Page } from "@playwright/test";
import { datenstandHeute, mockApi } from "./fixtures";

const von = (page: Page) => page.getByLabel("Zeitraum von");
const bis = (page: Page) => page.getByLabel("Zeitraum bis");
/** Leaves the focused field by clicking the card's padding (a blur() call is not delivered on a phone). */
const leave = (page: Page) => page.getByTestId("map-card").click({ position: { x: 3, y: 3 } });
const asked = (requests: URL[], path: string, query: Record<string, string>) =>
  requests.some(
    (u) =>
      u.pathname === path && Object.entries(query).every(([k, v]) => u.searchParams.get(k) === v),
  );

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
  await von(page).fill("2026-02-10");
  await expect(page).toHaveURL(/\/karte\?g=fern&von=2026-02-10$/);
  await page.goto("/bahnhof/8000207?bis=2026-04");
  await expect(bis(page)).toHaveValue("2026-04");
  await von(page).selectOption("2026-01");
  await expect(page).toHaveURL(/\?von=2026-01&bis=2026-04$/);
});

test("the map offers two date fields from the first to the last day, defaulting to the covered range", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/karte");
  await expect(von(page)).toHaveAttribute("type", "date");
  await expect(von(page)).toHaveValue("2025-11-01");
  await expect(bis(page)).toHaveValue("2026-09-30");
  for (const field of [von(page), bis(page)]) {
    await expect(field).toHaveAttribute("min", "2024-07-01");
    await expect(field).toHaveAttribute("max", "2026-09-30");
  }
  await expect(page).toHaveURL(/\/karte$/);
});

test("the map's fields stop at the last complete day, they do not offer a collector day", async ({
  page,
}) => {
  const none = [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ] as const;
  await mockApi(page, ...none, undefined, () => ({
    ...datenstandHeute(),
    live_tage: ["2026-10-01"],
  }));
  await page.goto("/karte");
  await expect(bis(page)).toHaveAttribute("max", "2026-09-30");
  await expect(von(page)).toHaveAttribute("max", "2026-09-30");
  await bis(page).fill("2026-10-01");
  await expect(page).toHaveURL(/\/karte$/);
});

test("picking days on the map writes them to the URL and the request carries them", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/karte");
  await von(page).fill("2026-03-10");
  await expect(page).toHaveURL(/\/karte\?von=2026-03-10$/);
  await bis(page).fill("2026-06-20");
  await expect(page).toHaveURL(/\/karte\?von=2026-03-10&bis=2026-06-20$/);
  await expect
    .poll(() => asked(requests, "/karte", { von: "2026-03-10", bis: "2026-06-20" }))
    .toBe(true);
  // The meta line sits in the legend, which a phone hides.
  await expect(page.getByText("1.–30. Sept. 2026 · Alle Gattungen")).toHaveCount(1);
});

test("on the map a von after bis moves bis, a bis before von moves von", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?von=2026-03-10&bis=2026-05-05");
  // The fields take days only once /datenstand has given their limits.
  await expect(von(page)).toHaveAttribute("min", "2024-07-01");
  // A day that crosses the other edge is applied when the field is left.
  await von(page).fill("2026-08-01");
  await leave(page);
  await expect(page).toHaveURL(/\?von=2026-08-01&bis=2026-08-01$/);
  await bis(page).fill("2026-01-15");
  await leave(page);
  await expect(page).toHaveURL(/\?von=2026-01-15&bis=2026-01-15$/);
  await expect(von(page)).toHaveValue("2026-01-15");
  await expect(bis(page)).toHaveValue("2026-01-15");
});

test("a month in the URL shows its first and last day on the map and goes to the API as it is", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/karte?von=2026-02&bis=2026-04");
  await expect(von(page)).toHaveValue("2026-02-01");
  await expect(bis(page)).toHaveValue("2026-04-30");
  await expect(page).toHaveURL(/\/karte\?von=2026-02&bis=2026-04$/);
  await expect.poll(() => asked(requests, "/karte", { von: "2026-02", bis: "2026-04" })).toBe(true);
});

test("days in the URL round outward to months on the pattern pages, which request months", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/muster/heatmap?von=2026-03-10&bis=2026-10-20");
  // The last month with data is 2026-09, so a later bis shows that.
  await expect(von(page)).toHaveValue("2026-03");
  await expect(bis(page)).toHaveValue("2026-09");
  await expect
    .poll(() => asked(requests, "/heatmap", { von: "2026-03", bis: "2026-09" }))
    .toBe(true);
  await expect(page).toHaveURL(/\?von=2026-03-10&bis=2026-10-20$/);
  await bis(page).selectOption("2026-06");
  await expect(page).toHaveURL(/\?von=2026-03&bis=2026-06$/);
});

test("a day past the last month asks for the last month, where the select stands", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/muster/heatmap?von=2026-10-05");
  await expect(von(page)).toHaveValue("2026-09");
  await expect.poll(() => asked(requests, "/heatmap", { von: "2026-09" })).toBe(true);
  expect(asked(requests, "/heatmap", { von: "2026-10" })).toBe(false);
  await page.goto("/muster/rankings?von=2026-10-05&bis=2026-10-30");
  await expect
    .poll(() => asked(requests, "/rankings", { von: "2026-09", bis: "2026-09" }))
    .toBe(true);
});

test("a month beyond the data shows the edge of the data in the map's fields", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?von=2024-01&bis=2026-12");
  await expect(von(page)).toHaveValue("2024-07-01");
  await expect(bis(page)).toHaveValue("2026-09-30");
  // Picking the other edge leaves the URL's month alone.
  await von(page).fill("2026-03-10");
  await expect(page).toHaveURL(/\/karte\?von=2026-03-10&bis=2026-12$/);
});

test("Zurücksetzen removes the days on the map and the fields return to the default", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/karte?von=2026-03-10&bis=2026-05-05");
  await expect(von(page)).toHaveValue("2026-03-10");
  await page.getByRole("button", { name: "Zurücksetzen" }).click();
  await expect(page).toHaveURL(/\/karte$/);
  await expect(von(page)).toHaveValue("2025-11-01");
  await expect(bis(page)).toHaveValue("2026-09-30");
});

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "a phone's date field is a picker, not typed");

  test("typing a day key by key into bis does not move von on the way", async ({ page }) => {
    await mockApi(page);
    await page.goto("/karte?von=2026-03-10&bis=2026-03-20");
    await bis(page).focus();
    // The first key makes day 02, which lies before von; the field passes through it.
    await bis(page).pressSequentially("25042026");
    await expect(page).toHaveURL(/\/karte\?von=2026-03-10&bis=2026-04-25$/);
    await expect(von(page)).toHaveValue("2026-03-10");
  });

  test("a crossing day typed into bis is applied when the field is left", async ({ page }) => {
    await mockApi(page);
    await page.goto("/karte?von=2026-03-10&bis=2026-03-20");
    await bis(page).focus();
    await bis(page).pressSequentially("05022026");
    await expect(page).toHaveURL(/\/karte\?von=2026-03-10&bis=2026-03-20$/);
    await von(page).focus();
    await expect(page).toHaveURL(/\/karte\?von=2026-02-05&bis=2026-02-05$/);
  });
});

test("days in the URL round outward to months on the station page", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/bahnhof/8000207?von=2026-03-10&bis=2026-04-20");
  await expect(von(page)).toHaveValue("2026-03");
  await expect(bis(page)).toHaveValue("2026-04");
  await expect
    .poll(() => asked(requests, "/stationen/8000207/statistik", { von: "2026-03", bis: "2026-04" }))
    .toBe(true);
  await expect(page).toHaveURL(/\?von=2026-03-10&bis=2026-04-20$/);
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

  for (const [what, path] of [
    ["selects", "/muster/heatmap"],
    ["date fields on the map", "/karte"],
  ]) {
    test(`both ${what} fit 375 px and have a hit area of at least 44 px`, async ({ page }) => {
      await mockApi(page);
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      for (const field of [von(page), bis(page)]) {
        const tap = field.locator("xpath=..");
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
  }
});
