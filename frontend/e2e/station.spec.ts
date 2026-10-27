import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  emptyStatistik,
  fontsReady,
  linienFixture,
  mockApi,
  queryOf,
  STATIONS,
  statistikFixture,
  zeitverlaufFixture,
} from "./fixtures";

// Scale tokens from theme.css as the browser reports them.
const R3 = "rgb(216, 190, 92)";
const R4 = "rgb(239, 138, 71)";
const R5 = "rgb(178, 24, 43)";
const CANCEL = "rgb(93, 102, 117)";

const tiles = (page: Page) => page.getByRole("list", { name: "Kennzahlen" }).getByRole("listitem");
const section = (page: Page, name: string) => page.getByRole("region", { name });
const pressed = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true }).and(scope.locator('[aria-pressed="true"]'));
const koeln = STATIONS[0];
/** The coloured left edge of a tile. */
const edge = (tile: Locator) => tile.locator("i").first();

test("the header shows name, identifier, breadcrumb and the actions", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207?g=fern");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Köln Hbf");
  await expect(page.getByRole("main")).toContainText("EVA 8000207 · Nordrhein-Westfalen");
  const crumb = page.getByRole("navigation", { name: "Brotkrumen" });
  await expect(crumb).toContainText("Karte › Köln Hbf");
  await expect(crumb.getByRole("link", { name: "Karte" })).toHaveAttribute(
    "href",
    "/karte?g=fern&bhf=8000207",
  );
  await expect(page.getByRole("button", { name: "Teilen" })).toBeVisible();
  // Not built yet: dimmed, tagged "bald", not a link.
  for (const name of ["Verbindung ab hier", "Umstiege hier"]) {
    await expect(page.getByRole("main").getByText(name)).toBeVisible();
    await expect(page.getByRole("link", { name })).toHaveCount(0);
  }
  // The station is the page, so the filter bar has no Bahnhof chip.
  await expect(page.getByLabel("Gattung:")).toHaveValue("fern");
  await expect(page.getByRole("button", { name: /^Bahnhof/ })).toHaveCount(0);
});

test("a bhf key is dropped from the URL", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207?bhf=8000105&g=fern");
  await expect(page).toHaveURL(/\/bahnhof\/8000207\?g=fern$/);
});

test("four tiles with value, sentence, meta and a coloured edge", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207");
  await expect(tiles(page)).toHaveCount(4);
  const [onTime, typical, bad, cancelled] = await tiles(page).all();
  const meta = "n = 33.744 Halte · Sept. 2026";
  const rows: [Locator, string[], string][] = [
    [onTime, ["Pünktlichkeit", "67 %", "6 von 10 Ankünften pünktlich"], R4],
    [typical, ["Typische Verspätung", "3 min", "Die Hälfte der Züge ist weniger spät"], R3],
    [bad, ["Schlechte Tage (P90)", "21 min", "9 von 10 Zügen sind höchstens so spät"], R5],
    [cancelled, ["✕", "Ausfälle", "4,3 %", "etwa 1 von 23 Halten fällt aus"], CANCEL],
  ];
  for (const [tile, texts, colour] of rows) {
    for (const text of texts) await expect(tile).toContainText(text);
    await expect(tile).toContainText(meta);
    await expect(edge(tile)).toHaveCSS("background-color", colour);
  }
});

test("a share of 96 % reads 9 von 10, never 10", async ({ page }) => {
  await mockApi(page, undefined, undefined, (s, g) => {
    const data = statistikFixture(s, g);
    return { ...data, gesamt: { ...data.gesamt!, puenktlich: 0.96 } };
  });
  await page.goto("/bahnhof/8000207");
  await expect(tiles(page).first()).toContainText("9 von 10 Ankünften pünktlich");
});

test("a filter change after another key keeps the page mounted", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207?k=median");
  const title = page.getByRole("heading", { level: 1 });
  await expect(tiles(page)).toHaveCount(4);
  await title.evaluate((el) => (el.dataset.mark = "kept"));
  await page.getByLabel("Gattung:").selectOption("fern");
  await expect(page).toHaveURL(/\/bahnhof\/8000207\?g=fern&k=median$/);
  await expect(title).toHaveAttribute("data-mark", "kept");
});

test("the term explanations are native titles", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207");
  await expect(tiles(page).first().locator("[title]")).toHaveAttribute(
    "title",
    "Ankunft weniger als 6 Minuten nach Plan (DB-Definition)",
  );
});

test("the distribution has 7 delay bars and a separate ausgefallen bar", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207");
  const card = section(page, "So verteilen sich die Ankünfte");
  await expect(card).toContainText("Anteil aller geplanten Halte nach Verspätung in Minuten");
  await expect(card).toContainText("← pünktlich (unter 6 min)");
  await expect(card).toContainText("verspätet →");
  const bars = card.getByRole("listitem");
  await expect(bars).toHaveCount(8);
  const delay: [string, string][] = [
    ["< 1", "44 %"],
    ["1–3", "21 %"],
    ["3–6", "13 %"],
    ["6–10", "9 %"],
    ["10–20", "5 %"],
    ["20–30", "2 %"],
    ["≥ 30", "1 %"],
  ];
  for (const [i, [label, value]] of delay.entries()) {
    await expect(bars.nth(i)).toContainText(`${label} min`);
    await expect(bars.nth(i)).toContainText(value);
  }
  await expect(bars.nth(7)).toContainText("ausgefallen");
  await expect(bars.nth(7)).toContainText("4,3 %");
});

test("mini heatmap and categories follow the metric; the heatmap link carries bhf", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/bahnhof/8000207?g=fern&k=median");
  const hm = section(page, "Wochentag × Uhrzeit");
  await expect(hm.getByRole("img", { name: /Typische Verspätung/ })).toBeVisible();
  await expect(hm.getByRole("link", { name: "Groß ansehen →" })).toHaveAttribute(
    "href",
    "/muster/heatmap?g=fern&bhf=8000207&k=median",
  );
  expect(
    requests.some(
      (u) =>
        u.pathname === "/heatmap" &&
        u.searchParams.get("eva") === "8000207" &&
        u.searchParams.get("gattung") === "fern",
    ),
  ).toBe(true);

  await page.goto("/bahnhof/8000207");
  const groups = section(page, "Nach Zuggattung");
  const rows = groups.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  const [regional, fern] = await rows.all();
  await expect(regional).toContainText("Regionalverkehr");
  await expect(regional).toContainText("70 %");
  await expect(regional).toContainText("n = 30.000");
  await expect(fern).toContainText("Fernverkehr");
  await expect(fern).toContainText("40 %");
  await expect(fern).toContainText("n = 3.744");
  await page.getByRole("button", { name: "Typische Verspätung" }).click();
  await expect(page).toHaveURL(/[?&]k=median/);
  await expect(regional).toContainText("3 min");
  await expect(fern).toContainText("5 min");
});

test("Gattung refetches the statistics", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/bahnhof/8000207");
  await expect(tiles(page).first()).toContainText("67 %");
  await page.getByLabel("Gattung:").selectOption("fern");
  await expect(page).toHaveURL(/[?&]g=fern/);
  await expect(tiles(page).first()).toContainText("40 %");
  expect(
    requests.some(
      (u) =>
        u.pathname === "/stationen/8000207/statistik" && u.searchParams.get("gattung") === "fern",
    ),
  ).toBe(true);
});

const history = (page: Page) => section(page, "Letzte 12 Monate");

test("the sparkline shows the last 12 months, the latest value and a link to the series", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/bahnhof/8000207?g=fern");
  const card = history(page);
  await expect(card.getByTestId("point")).toHaveCount(12);
  await expect(card.getByTestId("segment")).toHaveCount(11);
  await expect(card.getByTestId("segment").and(card.locator("[stroke-dasharray]"))).toHaveCount(0);
  await expect(card).toContainText("72 %");
  await expect(card).toContainText("pünktlich im Sep 26 · n = 22.600");
  await expect(card.getByRole("link", { name: "Zeitverlauf →" })).toHaveAttribute(
    "href",
    "/muster/zeitverlauf?g=fern&bhf=8000207",
  );
  const request = requests.find((u) => u.pathname === "/zeitverlauf");
  expect(queryOf(request)).toEqual({ eva: "8000207", gattung: "fern" });
  // A scroll clears the tooltip, so the month is brought into view first.
  const month = card.getByTestId("sp-2026-03");
  await fontsReady(page);
  await month.scrollIntoViewIfNeeded();
  await month.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Mär 26 · 78 % pünktlich · n = 1.240");
  await card.getByRole("link", { name: "Zeitverlauf →" }).click();
  await expect(page).toHaveURL(/\/muster\/zeitverlauf\?g=fern&bhf=8000207$/);
  await expect(page.getByRole("main")).toContainText("Köln Hbf");
});

test("a month with little data in the sparkline is dashed", async ({ page }) => {
  await mockApi(page, undefined, undefined, undefined, undefined, undefined, (e, l) => {
    const data = zeitverlaufFixture(e, l);
    return {
      ...data,
      monate: data.monate.map((m) => (m.monat === "2026-01" ? { ...m, n: 9 } : m)),
    };
  });
  await page.goto("/bahnhof/8000207");
  const card = history(page);
  await expect(card.getByTestId("point")).toHaveCount(12);
  await expect(card.getByTestId("segment").and(card.locator("[stroke-dasharray]"))).toHaveCount(2);
});

/** The fixture series with the given months cut down to 9 stops. */
const thinMonths = (months: string[]) => (e: string | null, l: string | null) => {
  const data = zeitverlaufFixture(e, l);
  return {
    ...data,
    monate: data.monate.map((m) => (months.includes(m.monat) ? { ...m, n: 9 } : m)),
  };
};

test("the sparkline headline is the latest month with enough data, with its n", async ({
  page,
}) => {
  await mockApi(page, undefined, undefined, undefined, undefined, undefined, (e, l) => {
    const data = zeitverlaufFixture(e, l);
    // 2026-08 has 9 stops; 2026-09 has 40, but 32 of them are cancelled: 8 arrivals.
    const monate = data.monate.map((m) => {
      if (m.monat === "2026-08") return { ...m, n: 9 };
      return m.monat === "2026-09" ? { ...m, n: 40, ausfallquote: 0.8 } : m;
    });
    return { ...data, monate };
  });
  await page.goto("/bahnhof/8000207");
  const card = history(page);
  await expect(card.getByTestId("point")).toHaveCount(12);
  // 2026-07: 22,400 stops, 78 %.
  await expect(card.locator("b")).toHaveText("78 %");
  await expect(card).toContainText("pünktlich im Jul 26 · n = 22.400");
});

test("the sparkline headline is a dash when no month has enough data", async ({ page }) => {
  const last12 = ["2025-10", "2025-11", "2025-12"].concat(
    Array.from({ length: 9 }, (_, i) => `2026-0${i + 1}`),
  );
  await mockApi(page, undefined, undefined, undefined, undefined, undefined, thinMonths(last12));
  await page.goto("/bahnhof/8000207");
  const card = history(page);
  await expect(card.getByTestId("point")).toHaveCount(12);
  const headline = card.locator("p").first();
  await expect(headline.locator("b")).toHaveText("–");
  await expect(headline).toContainText("zu wenig Daten");
  await expect(headline).not.toContainText("pünktlich im");
});

test("the sparkline card has its own error and the rest of the page stays", async ({ page }) => {
  let calls = 0;
  await mockApi(page, undefined, undefined, undefined, undefined, undefined, (e, l) =>
    calls++ === 0 ? null : zeitverlaufFixture(e, l),
  );
  await page.goto("/bahnhof/8000207");
  await expect(tiles(page)).toHaveCount(4);
  await expect(history(page).getByRole("alert")).toContainText(
    "Daten konnten nicht geladen werden.",
  );
  await history(page).getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(history(page).getByTestId("point")).toHaveCount(12);
});

test("a line row links to the time series of that line, keeping category and delay view", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207?g=fern&k=median");
  const link = lines(page).first().getByRole("link");
  await expect(link).toHaveAttribute(
    "href",
    "/muster/zeitverlauf?g=fern&linie=RE+1%3A8000207&k=median",
  );
  await link.click();
  await expect(page).toHaveURL(/\/muster\/zeitverlauf\?g=fern&linie=RE\+1%3A8000207&k=median$/);
  await expect(page.getByText(/^Linie:\s*RE 1 · Köln Hbf/)).toBeVisible();
  await expect(page.getByRole("img", { name: "Verspätung pro Monat" })).toBeVisible();
});

test("a line row keeps the P90 metric as the delay view and drops the cancellation one", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207?k=p90");
  await expect(lines(page).first().getByRole("link")).toHaveAttribute(
    "href",
    "/muster/zeitverlauf?linie=RE+1%3A8000207&k=median",
  );
  await page.goto("/bahnhof/8000207?k=ausfall");
  await expect(lines(page).first().getByRole("link")).toHaveAttribute(
    "href",
    "/muster/zeitverlauf?linie=RE+1%3A8000207",
  );
});

const lines = (page: Page) => section(page, "Linien an diesem Bahnhof").getByRole("listitem");

test("the lines table shows the first ten, worst first, and expands in place", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/bahnhof/8000207?g=fern&von=2026-01");
  const card = section(page, "Linien an diesem Bahnhof");
  await expect(pressed(card, "Schlechteste zuerst")).toBeVisible();
  await expect(lines(page)).toHaveCount(10);
  const first = lines(page).first();
  for (const text of ["RE 1 · Köln Hbf", "RE", "50 %", "n = 1.500", "✕ 2,0 %"])
    await expect(first).toContainText(text);
  await expect(first.locator("i")).toHaveCSS("background-color", R5);
  const request = requests.find((u) => u.pathname === "/stationen/8000207/linien");
  expect(queryOf(request)).toEqual({ gattung: "fern", von: "2026-01" });
  await card.getByRole("button", { name: "Alle 12 Linien anzeigen" }).click();
  await expect(lines(page)).toHaveCount(12);
  await expect(card.getByRole("button", { name: "Alle 12 Linien anzeigen" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Weniger anzeigen" })).toBeVisible();
  await expect(lines(page).last()).toContainText("RE 12 · Köln Hbf");
});

test("Weniger anzeigen collapses to ten rows and hands the focus to the toggle", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207");
  const card = section(page, "Linien an diesem Bahnhof");
  await card.getByRole("button", { name: "Alle 12 Linien anzeigen" }).click();
  await expect(lines(page)).toHaveCount(12);
  await card.getByRole("button", { name: "Weniger anzeigen" }).click();
  await expect(lines(page)).toHaveCount(10);
  await expect(card.getByRole("button", { name: "Alle 12 Linien anzeigen" })).toBeFocused();
});

test("Beste zuerst reverses the lines with a value and keeps the others last", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207");
  const card = section(page, "Linien an diesem Bahnhof");
  await card.getByRole("button", { name: "Alle 12 Linien anzeigen" }).click();
  await expect(lines(page).nth(9)).toContainText("RE 10 · Köln Hbf");
  await expect(lines(page).nth(10)).toContainText("RE 11 · Köln Hbf");
  await expect(lines(page).nth(11)).toContainText("RE 12 · Köln Hbf");
  await card.getByRole("button", { name: "Beste zuerst" }).click();
  await expect(pressed(card, "Beste zuerst")).toBeVisible();
  await expect(lines(page)).toHaveCount(12);
  await expect(lines(page).first()).toContainText("RE 10 · Köln Hbf");
  await expect(lines(page).nth(9)).toContainText("RE 1 · Köln Hbf");
  // RE 11 has no value (all stops cancelled) and RE 12 only 9 stops: both stay behind the others.
  await expect(lines(page).nth(10)).toContainText("RE 11 · Köln Hbf");
  await expect(lines(page).last()).toContainText("RE 12 · Köln Hbf");
  await expect(lines(page).last()).toContainText("n = 9");
  await card.getByRole("button", { name: "Schlechteste zuerst" }).click();
  await expect(lines(page).first()).toContainText("RE 1 · Köln Hbf");
  await expect(lines(page).nth(10)).toContainText("RE 11 · Köln Hbf");
  await expect(lines(page).last()).toContainText("RE 12 · Köln Hbf");
});

test("a cancellation rate of 10 % or more stays on one line in the lines table", async ({
  page,
}) => {
  await mockApi(page, undefined, undefined, undefined, undefined, () =>
    linienFixture().map((l, i) => (i === 0 ? { ...l, ausfallquote: 0.109 } : l)),
  );
  await page.goto("/bahnhof/8000207");
  await expect(lines(page)).toHaveCount(10);
  const cell = lines(page).first().getByText("✕ 10,9 %");
  await expect(cell).toBeVisible();
  expect((await cell.boundingBox())!.height).toBeLessThan(20);
});

test("expanding the lines with the keyboard moves focus to the first new row", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207");
  const card = section(page, "Linien an diesem Bahnhof");
  await expect(lines(page)).toHaveCount(10);
  const button = card.getByRole("button", { name: "Alle 12 Linien anzeigen" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(lines(page)).toHaveCount(12);
  await expect(lines(page).nth(10).getByRole("link")).toBeFocused();
});

test("a line with too little data is hatched and shows no value", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207");
  await section(page, "Linien an diesem Bahnhof")
    .getByRole("button", { name: "Alle 12 Linien anzeigen" })
    .click();
  const low = lines(page).nth(11);
  await expect(low).toContainText("RE 12 · Köln Hbf");
  await expect(low).toContainText("n = 9");
  await expect(low).toContainText("–");
  await expect(low.getByText("59 %")).toHaveCount(0);
  await expect(low.locator("i")).toHaveCSS("background-image", /repeating-linear-gradient/);
});

test("a station without lines says so", async ({ page }) => {
  await mockApi(page, undefined, undefined, undefined, undefined, () => []);
  await page.goto("/bahnhof/8000207");
  await expect(section(page, "Linien an diesem Bahnhof")).toContainText(
    "Mit diesen Filtern gibt es hier keine Linien.",
  );
});

test("the lines card shows its own error and the rest of the page stays", async ({ page }) => {
  let calls = 0;
  await mockApi(page, undefined, undefined, undefined, undefined, () =>
    calls++ === 0 ? null : linienFixture(),
  );
  await page.goto("/bahnhof/8000207");
  await expect(tiles(page)).toHaveCount(4);
  const card = section(page, "Linien an diesem Bahnhof");
  await expect(card.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await expect(section(page, "Nach Zuggattung")).toBeVisible();
  await card.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(lines(page)).toHaveCount(10);
});

test("little data gets a note and hatched, empty-looking tiles", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000999");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kleinstadt");
  await expect(page.getByRole("main")).toContainText("Wenig Daten (n = 9) – Werte schwanken stark");
  await expect(tiles(page).first()).toContainText("–");
  await expect(tiles(page).first()).toContainText("zu wenig Daten");
});

test("an empty period offers a reset", async ({ page }) => {
  await mockApi(page, undefined, undefined, (s) => emptyStatistik(s));
  await page.goto("/bahnhof/8000207?g=fern");
  await expect(page.getByText("Keine Ankünfte im Zeitraum")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Köln Hbf");
  await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
  await expect(page).toHaveURL(/\/bahnhof\/8000207$/);
});

test("the error state keeps the filters and recovers on retry", async ({ page }) => {
  let calls = 0;
  await mockApi(page, undefined, undefined, (s, g) =>
    calls++ === 0 ? null : statistikFixture(s, g),
  );
  await page.goto("/bahnhof/8000207?g=fern");
  await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(tiles(page)).toHaveCount(4);
  await expect(page).toHaveURL(/[?&]g=fern/);
});

test("a station the API does not know offers a search", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/9999999?g=fern");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Diesen Bahnhof kennen wir nicht",
  );
  await expect(page.getByText("Vielleicht ein Tippfehler im Link?")).toBeVisible();
  const search = page.getByRole("combobox", { name: "Bahnhof suchen" });
  await search.fill("köln");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/bahnhof\/8000207\?g=fern$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Köln Hbf");
});

test("an invalid EVA is unknown without asking the API", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/bahnhof/abc");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Diesen Bahnhof kennen wir nicht",
  );
  expect(requests.some((u) => u.pathname.endsWith("/statistik"))).toBe(false);
});

test("the breadcrumb leads back to the map with the station selected", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207");
  await page
    .getByRole("navigation", { name: "Brotkrumen" })
    .getByRole("link", { name: "Karte" })
    .click();
  await expect(page).toHaveURL(/\/karte\?bhf=8000207$/);
  await expect(page.getByRole("complementary").getByRole("heading", { level: 2 })).toHaveText(
    koeln.name,
  );
});

test("the map panel's Alle Details lands on the station page", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?g=fern&bhf=8000207");
  await page.getByRole("link", { name: "Alle Details" }).click();
  await expect(page).toHaveURL(/\/bahnhof\/8000207\?g=fern$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Köln Hbf");
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("one column, tiles 2 × 2, no sideways scroll", async ({ page }) => {
    await mockApi(page);
    await page.goto("/bahnhof/8000207");
    await expect(tiles(page)).toHaveCount(4);
    const [a, b, c, d] = await Promise.all((await tiles(page).all()).map((x) => x.boundingBox()));
    expect(b!.x).toBeGreaterThan(a!.x);
    expect(b!.y).toBe(a!.y);
    expect(c!.x).toBe(a!.x);
    expect(c!.y).toBeGreaterThan(a!.y);
    expect(d!.x).toBe(b!.x);
    const hm = (await section(page, "Wochentag × Uhrzeit").boundingBox())!;
    const groups = (await section(page, "Nach Zuggattung").boundingBox())!;
    expect(groups.x).toBe(hm.x);
    expect(groups.y).toBeGreaterThan(hm.y + hm.height - 1);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(fits).toBe(true);
  });

  test("the lines become row cards: the bar sits below the name", async ({ page }) => {
    await mockApi(page);
    await page.goto("/bahnhof/8000207");
    await expect(lines(page)).toHaveCount(10);
    const row = lines(page).first();
    const name = (await row.getByText("RE 1 · Köln Hbf").boundingBox())!;
    const bar = (await row.locator("i").boundingBox())!;
    expect(bar.y).toBeGreaterThan(name.y + name.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("small controls have a hit area of at least 44 px", async ({ page }) => {
    await mockApi(page);
    await page.goto("/bahnhof/8000207");
    await expect(tiles(page)).toHaveCount(4);
    await expect(lines(page)).toHaveCount(10);
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
      page.getByRole("navigation", { name: "Brotkrumen" }).getByRole("link", { name: "Karte" }),
      page.getByRole("link", { name: "Groß ansehen →" }),
      page.getByRole("link", { name: "Zeitverlauf →" }),
      page.getByRole("button", { name: "Teilen" }),
      page.getByRole("button", { name: "Ausfälle", exact: true }),
      page.getByRole("button", { name: "Alle 12 Linien anzeigen" }),
      page.getByRole("button", { name: "Beste zuerst" }),
    ];
    for (const c of controls) expect(await tall(c), `${await c.textContent()}`).toBe(true);
  });
});
