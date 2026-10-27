import { expect, test, type Page } from "@playwright/test";
import { fontsReady, mockApi, NOT_FOUND, queryOf, zeitverlaufFixture } from "./fixtures";

// Scale tokens from theme.css as the browser reports them.
const CANCEL = "rgb(93, 102, 117)";

const chart = (page: Page, name = "Pünktlichkeit pro Monat") =>
  page.getByRole("img", { name, exact: true });
const segments = (page: Page) => page.getByTestId("segment");
const dashed = (page: Page) => page.locator('[data-testid="segment"][stroke-dasharray]');
const tip = (page: Page) => page.getByRole("tooltip");
const requests = (all: URL[]) => all.filter((u) => u.pathname === "/zeitverlauf");
/** The query of the latest /zeitverlauf request. */
const lastQuery = (all: URL[]) => queryOf(requests(all).at(-1));
const LINE = "linie=RE+1%3A8000207";
/** The plot's lower edge in px: the SVG is 260 px high and the month labels take 22 px. */
const PLOT_BOTTOM = 238;

/** The fixture with 20 stops in 2026-05, half of them cancelled: 10 arrivals, too few for delays. */
const fewArrivals = (e: string | null, l: string | null) => {
  const data = zeitverlaufFixture(e, l);
  return {
    ...data,
    monate: data.monate.map((m) =>
      m.monat === "2026-05" ? { ...m, n: 20, ausfallquote: 0.5 } : m,
    ),
  };
};

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("the request is nationwide by default and the title names the selection", async ({
    page,
  }) => {
    const all = await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    await expect(chart(page)).toBeVisible();
    expect(lastQuery(all)).toEqual({ gattung: "alle" });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Zeitverlauf");
    await expect(page.getByRole("main")).toContainText("Deutschland gesamt");
    await expect(page).toHaveURL(/\/muster\/zeitverlauf$/);
  });

  test("the period picker is gone and the meta line says all months", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf?von=2026-01");
    await expect(chart(page)).toBeVisible();
    await expect(page.getByLabel("Zeitraum von")).toHaveCount(0);
    await expect(page.getByLabel("Zeitraum bis")).toHaveCount(0);
    await expect(page.getByText(/alle Monate/)).toBeVisible();
    // Another page's keys stay in the link.
    await expect(page).toHaveURL(/von=2026-01/);
  });

  test("a station and the category go into the request", async ({ page }) => {
    const all = await mockApi(page);
    await page.goto("/muster/zeitverlauf?bhf=8000207&g=fern");
    await expect(chart(page)).toBeVisible();
    expect(lastQuery(all)).toEqual({ eva: "8000207", gattung: "fern" });
    await expect(page.getByRole("main")).toContainText("Köln Hbf");
  });

  test("a line wins over a station, which is dropped; the line chip is removable", async ({
    page,
  }) => {
    const all = await mockApi(page);
    await page.goto(`/muster/zeitverlauf?${LINE}&bhf=8000207&g=fern`);
    await expect(chart(page)).toBeVisible();
    await expect(page).toHaveURL(`/muster/zeitverlauf?g=fern&${LINE}`);
    expect(lastQuery(all)).toEqual({ linie: "RE 1:8000207", gattung: "fern" });
    const chip = page.getByText(/^Linie:/);
    await expect(chip).toContainText("RE 1 · Köln Hbf");
    await page.getByRole("button", { name: "Linie entfernen" }).click();
    await expect(page).toHaveURL(/\/muster\/zeitverlauf\?g=fern$/);
    await expect(chip).toHaveCount(0);
    await expect.poll(() => lastQuery(all)).toEqual({ gattung: "fern" });
  });

  test("picking a station while a line is set replaces the line", async ({ page }) => {
    const all = await mockApi(page);
    await page.goto(`/muster/zeitverlauf?${LINE}`);
    await expect(page.getByText(/^Linie:/)).toContainText("RE 1 · Köln Hbf");
    await page.getByRole("button", { name: /^Bahnhof/ }).click();
    await page.getByRole("combobox", { name: "Bahnhof suchen" }).fill("köln");
    await page.getByRole("option", { name: /Köln Hbf/ }).click();
    await expect(page).toHaveURL(/\/muster\/zeitverlauf\?bhf=8000207$/);
    await expect(page.getByText(/^Linie:/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Bahnhof/ })).toContainText("Köln Hbf");
    await expect.poll(() => lastQuery(all)).toEqual({ eva: "8000207", gattung: "alle" });
  });

  test("a median below zero stays inside the plot", async ({ page }) => {
    await mockApi(page, undefined, undefined, undefined, undefined, undefined, (e, l) => {
      const data = zeitverlaufFixture(e, l);
      const below = (m: (typeof data.monate)[number]) =>
        m.median === null ? m : { ...m, median: -1, p90: 1 + (m.n % 7) };
      return { ...data, monate: data.monate.map(below) };
    });
    await page.goto("/muster/zeitverlauf?k=median");
    const points = chart(page, "Verspätung pro Monat").getByTestId("point");
    await expect(points).toHaveCount(26);
    const ys = await points.evaluateAll((all) => all.map((p) => Number(p.getAttribute("cy"))));
    for (const y of ys) expect(y).toBeLessThanOrEqual(PLOT_BOTTOM);
    await expect(chart(page, "Verspätung pro Monat").getByText("-5 min")).toBeVisible();
  });

  test("a month with too few arrivals follows the low-data rule everywhere", async ({ page }) => {
    await mockApi(page, undefined, undefined, undefined, undefined, undefined, fewArrivals);
    await page.goto("/muster/zeitverlauf");
    const svg = chart(page);
    await expect(svg.getByTestId("point")).toHaveCount(26);
    // Hollow: 2025-02, 2025-06 (gap hours) and the new month. Dashed: two segments each.
    await expect(svg.locator("circle.fill-surface")).toHaveCount(3);
    await expect(dashed(page)).toHaveCount(6);
    await page.getByTestId("zv-2026-05").hover();
    await expect(tip(page)).toHaveText("Mai 26 · n = 20 · zu wenig Daten");
    await page.getByRole("button", { name: "Verspätung", exact: true }).click();
    await page.getByTestId("zv-2026-05").hover();
    await expect(tip(page)).toHaveText("Mai 26 · n = 20 · zu wenig Daten");
    // The cancellation rate counts all stops, so it still has its value.
    const bars = chart(page, "Ausfallquote pro Monat");
    await fontsReady(page);
    await bars.scrollIntoViewIfNeeded();
    await page.getByTestId("zc-2026-05").hover();
    await expect(tip(page)).toContainText("50");
    await expect(tip(page)).not.toContainText("zu wenig");
  });

  test("an unknown line has its own state with a way back", async ({ page }) => {
    const all = await mockApi(
      page,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (e, l) => (l ? NOT_FOUND : zeitverlaufFixture(e, l)),
    );
    await page.goto(`/muster/zeitverlauf?g=fern&${LINE}`);
    await expect(page.getByText("Diese Linie gibt es in den Daten nicht (mehr)")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Auswahl entfernen" }).click();
    await expect(page).toHaveURL(/\/muster\/zeitverlauf\?g=fern$/);
    await expect(chart(page)).toBeVisible();
    expect(lastQuery(all)).toEqual({ gattung: "fern" });
  });

  test("an unknown station has its own state with a way back", async ({ page }) => {
    await mockApi(page, undefined, undefined, undefined, undefined, undefined, (e, l) =>
      e ? NOT_FOUND : zeitverlaufFixture(e, l),
    );
    await page.goto("/muster/zeitverlauf?bhf=9999999");
    await expect(page.getByText("Diesen Bahnhof kennen wir nicht")).toBeVisible();
    await page.getByRole("button", { name: "Auswahl entfernen" }).click();
    await expect(page).toHaveURL(/\/muster\/zeitverlauf$/);
    await expect(chart(page)).toBeVisible();
  });

  test("one point per month with data, a hole at n = 0, dashes for low n and gaps", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    const svg = chart(page);
    await expect(svg).toBeVisible();
    // 27 months, one of them empty.
    await expect(svg.getByTestId("point")).toHaveCount(26);
    // 26 neighbours, two of them touch the hole; two more touch 2025-02 and two 2025-06.
    await expect(segments(page)).toHaveCount(24);
    await expect(dashed(page)).toHaveCount(4);
    await expect(svg.getByTestId("band")).toHaveCount(0);
  });

  test("markers sit at the timetable changes and at the start of full coverage", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    const svg = chart(page);
    await expect(svg.getByText("Fahrplanwechsel")).toHaveCount(2);
    await expect(svg.getByText("Datenbasis erweitert")).toHaveCount(1);
    await expect(svg.getByText("ab hier alle Bahnhöfe")).toHaveCount(0);
    // The note names the months from /datenstand: the one before full coverage, and the first.
    await expect(
      page.getByText("Bis Okt 25 nur rund 130 große Bahnhöfe, ab Nov 25 alle."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Als Tabelle anzeigen" }).click();
    await expect(page.getByText(/rund 130 große Bahnhöfe/)).toHaveCount(0);
  });

  test("the coverage marker is left out when the range starts at full coverage", async ({
    page,
  }) => {
    await mockApi(page, undefined, undefined, undefined, undefined, undefined, (e, l) => {
      const data = zeitverlaufFixture(e, l);
      return { ...data, monate: data.monate.filter((m) => m.monat >= "2025-11") };
    });
    await page.goto("/muster/zeitverlauf");
    const svg = chart(page);
    await expect(svg.getByText("Fahrplanwechsel")).toHaveCount(1);
    await expect(svg.getByText("Datenbasis erweitert")).toHaveCount(0);
    await expect(page.getByText(/rund 130 große Bahnhöfe/)).toHaveCount(0);
  });

  test("the delay metric draws the median line with a band up to P90", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    await page.getByRole("button", { name: "Verspätung", exact: true }).click();
    await expect(page).toHaveURL(/[?&]k=median/);
    const svg = chart(page, "Verspätung pro Monat");
    await expect(svg).toBeVisible();
    // Two runs of months with data, on both sides of the hole.
    await expect(svg.getByTestId("band")).toHaveCount(2);
    await expect(svg.getByTestId("point")).toHaveCount(26);
    await expect(svg.getByText("10 min")).toBeVisible();
  });

  test("hovering a month shows its value, n and the missing hours", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    await expect(chart(page)).toBeVisible();
    await page.getByTestId("zv-2026-03").hover();
    await expect(tip(page)).toHaveText("Mär 26 · 78 % pünktlich · n = 1.240");
    await page.getByTestId("zv-2025-06").hover();
    await expect(tip(page)).toContainText("Jun 25 · ");
    await expect(tip(page)).toContainText("12 h ohne vollständige Daten");
    await page.getByTestId("zv-2024-10").hover();
    await expect(tip(page)).toHaveText("Okt 24 · keine Daten");
    await page.getByTestId("zv-2025-02").hover();
    await expect(tip(page)).toContainText("n = 9");
    await expect(tip(page)).toContainText("zu wenig Daten");
  });

  test("a tap outside clears the tooltip", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    await page.getByTestId("zv-2026-03").click();
    await expect(tip(page)).toBeVisible();
    await page.getByRole("heading", { level: 1 }).click();
    await expect(tip(page)).toHaveCount(0);
  });

  test("the cancellation rate has its own bar chart on the same months", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    const bars = chart(page, "Ausfallquote pro Monat");
    await expect(bars).toBeVisible();
    await expect(bars.getByTestId("bar")).toHaveCount(26);
    await expect(bars.getByTestId("bar").first()).toHaveCSS("fill", CANCEL);
    // A scroll clears the tooltip, so bring the chart into view first.
    await fontsReady(page);
    await bars.scrollIntoViewIfNeeded();
    await page.getByTestId("zc-2026-03").hover();
    await expect(tip(page)).toContainText("Mär 26 · ");
    await expect(tip(page)).toContainText("ausgefallen");
  });

  test("the table mode lists every month with its values, n and gap hours", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    await page.getByRole("button", { name: "Als Tabelle anzeigen" }).click();
    await expect(chart(page)).toHaveCount(0);
    const table = page.getByRole("table");
    await expect(table.locator("tbody tr")).toHaveCount(27);
    for (const head of ["Monat", "Pünktlichkeit", "Ausfälle", "Stichprobe", "Stunden mit Lücken"])
      await expect(table.getByRole("columnheader", { name: head })).toBeVisible();
    const march = table.getByRole("row", { name: /Mär 26/ });
    for (const text of ["78 %", "1.240"]) await expect(march).toContainText(text);
    await expect(table.getByRole("row", { name: /Jun 25/ })).toContainText("12");
    await page.getByRole("button", { name: "Als Tabelle anzeigen" }).click();
    await expect(chart(page)).toBeVisible();
  });

  test("a series without a single stop shows an empty state", async ({ page }) => {
    await mockApi(page, undefined, undefined, undefined, undefined, undefined, (e, l) => {
      const data = zeitverlaufFixture(e, l);
      return {
        ...data,
        monate: data.monate.map((m) => ({
          monat: m.monat,
          n: 0,
          ausfallquote: null,
          median: null,
          p90: null,
          puenktlich: null,
        })),
      };
    });
    await page.goto("/muster/zeitverlauf?g=fern");
    await expect(page.getByText("Noch keine Monatsdaten")).toBeVisible();
    await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
    await expect(page).toHaveURL(/\/muster\/zeitverlauf$/);
  });

  test("the sidebar marks Zeitverlauf and keeps the filters in its link", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf?g=fern");
    const link = page
      .getByRole("navigation", { name: "Hauptnavigation" })
      .getByRole("link", { name: "Zeitverlauf" });
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(link).toHaveAttribute("href", "/muster/zeitverlauf?g=fern");
  });

  test("a filter change keeps the page mounted", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf?k=median");
    const title = page.getByRole("heading", { level: 1 });
    await expect(chart(page, "Verspätung pro Monat")).toBeVisible();
    await title.evaluate((el) => (el.dataset.mark = "kept"));
    await page.getByLabel("Gattung:").selectOption("fern");
    await expect(page).toHaveURL(/\/muster\/zeitverlauf\?g=fern&k=median$/);
    await expect(title).toHaveAttribute("data-mark", "kept");
  });
});

test("the error state keeps the filters and recovers on retry", async ({ page }) => {
  let calls = 0;
  await mockApi(page, undefined, undefined, undefined, undefined, undefined, (e, l) =>
    calls++ === 0 ? null : zeitverlaufFixture(e, l),
  );
  await page.goto("/muster/zeitverlauf?g=fern");
  await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(chart(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]g=fern/);
});

test("Teilen copies the link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page);
  await page.goto("/muster/zeitverlauf?g=fern");
  await page.getByRole("button", { name: "Teilen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link kopiert" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/g=fern$/);
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("the charts fit 375 px without sideways scroll and the marker labels do not overlap", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    await expect(chart(page)).toBeVisible();
    await expect(chart(page, "Ausfallquote pro Monat")).toBeVisible();
    // The labels are measured one by one; a swap to Inter in between moves the chart down.
    await fontsReady(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const name of ["Pünktlichkeit pro Monat", "Ausfallquote pro Monat"]) {
      const box = (await chart(page, name).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    const labels = await chart(page)
      .locator("text")
      .filter({ hasText: /Fahrplanwechsel|Datenbasis/ })
      .all();
    expect(labels).toHaveLength(3);
    const boxes = await Promise.all(labels.map((l) => l.boundingBox()));
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1)) {
        const apart =
          a!.x + a!.width <= b!.x ||
          b!.x + b!.width <= a!.x ||
          a!.y + a!.height <= b!.y ||
          b!.y + b!.height <= a!.y;
        expect(apart).toBe(true);
      }
  });

  test("a tap shows a month and a tap outside clears it", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/zeitverlauf");
    await page.getByTestId("zv-2026-03").tap();
    await expect(tip(page)).toContainText("Mär 26 · 78 % pünktlich");
    await page.getByRole("heading", { level: 1 }).tap();
    await expect(tip(page)).toHaveCount(0);
  });
});
