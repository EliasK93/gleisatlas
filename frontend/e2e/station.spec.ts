import { expect, test, type Locator, type Page } from "@playwright/test";
import { emptyStatistik, mockApi, STATIONS, statistikFixture } from "./fixtures";

// Scale tokens from theme.css as the browser reports them.
const R3 = "rgb(216, 190, 92)";
const R4 = "rgb(239, 138, 71)";
const R5 = "rgb(178, 24, 43)";
const CANCEL = "rgb(93, 102, 117)";

const tiles = (page: Page) => page.getByRole("list", { name: "Kennzahlen" }).getByRole("listitem");
const section = (page: Page, name: string) => page.getByRole("region", { name });
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
    ["0–1", "44 %"],
    ["1–3", "21 %"],
    ["3–6", "13 %"],
    ["6–10", "9 %"],
    ["10–20", "5 %"],
    ["20–30", "2 %"],
    ["> 30", "1 %"],
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

test("the coming-soon cards say what is missing", async ({ page }) => {
  await mockApi(page);
  await page.goto("/bahnhof/8000207");
  for (const name of ["Linien an diesem Bahnhof", "Letzte 12 Monate"]) {
    const card = section(page, name);
    await expect(card).toContainText("bald");
    await expect(card.locator("p")).toHaveCount(1);
  }
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

  test("small controls have a hit area of at least 44 px", async ({ page }) => {
    await mockApi(page);
    await page.goto("/bahnhof/8000207");
    await expect(tiles(page)).toHaveCount(4);
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
      page.getByRole("button", { name: "Teilen" }),
      page.getByRole("button", { name: "Ausfälle", exact: true }),
    ];
    for (const c of controls) expect(await tall(c), `${await c.textContent()}`).toBe(true);
  });
});
