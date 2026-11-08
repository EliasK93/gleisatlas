import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  abschnitteRanglisteFixture,
  emptyRangliste,
  fontsReady,
  LINE_ID,
  mockApi,
  queryOf,
  rankingFixture,
  rekordeFixture,
} from "./fixtures";

// Scale tokens from theme.css as the browser reports them.
const R1 = "rgb(33, 102, 172)";
const R2 = "rgb(103, 169, 207)";
const R4 = "rgb(239, 138, 71)";
const R5 = "rgb(178, 24, 43)";
const CANCEL = "rgb(93, 102, 117)";

const column = (page: Page, name: string) => page.getByRole("region", { name });
const WORST = "Am unzuverlässigsten";
const BEST = "Am zuverlässigsten";
const LOSE = "Verlieren am meisten Zeit";
const MAKE_UP = "Holen am meisten auf";
const MOST = "Die meisten";
const FEWEST = "Die wenigsten";
/** The mockApi arguments before `rankingAbschnitte` and `rekorde`, left at their defaults. */
const DEFAULTS = [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
] as const;
const kind = (page: Page) => page.getByRole("group", { name: "Art der Rangliste" });
/** The query of the latest request to `path`. */
const lastOf = (requests: URL[], path: string) =>
  queryOf(requests.filter((u) => u.pathname === path).at(-1));
const noScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const rankingRequests = (requests: URL[]) => requests.filter((u) => u.pathname === "/rankings");
/** The query of the latest /rankings request. */
const lastQuery = (requests: URL[]) => queryOf(rankingRequests(requests).at(-1));
/** The "Show more" button under a list. */
const more = (list: Locator) => list.getByRole("button", { name: "Mehr anzeigen" });
const pressed = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).and(page.locator('[aria-pressed="true"]'));

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("two columns of ten with rank, name, value, n and the cancellation rate", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/muster/rankings");
    const worst = column(page, WORST);
    const best = column(page, BEST);
    await expect(worst.getByRole("listitem")).toHaveCount(10);
    await expect(best.getByRole("listitem")).toHaveCount(10);
    const first = worst.getByRole("listitem").first();
    for (const text of ["1", "Problemhausen Nord 0", "50 %", "n = 20.000", "✕ 8,0 %"])
      await expect(first).toContainText(text);
    await expect(first.locator("i")).toHaveCSS("background-color", R5);
    await expect(worst.getByRole("listitem").nth(9)).toContainText("68 %");
    const top = best.getByRole("listitem").first();
    await expect(top).toContainText("99 %");
    await expect(top).toContainText("✕ 0,4 %");
    await expect(top.locator("i")).toHaveCSS("background-color", R1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rankings");
    await expect(page.getByRole("tablist")).toHaveCount(0);
  });

  test("the meta line names the threshold and the period", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings");
    const meta = page.getByText(/2\.445 Bahnhöfe mit mindestens 500 Halten/);
    await expect(meta).toBeVisible();
    await expect(meta).toContainText("Sept. 2026");
  });

  test("the request carries the defaults and nothing else", async ({ page }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings");
    await expect(column(page, WORST)).toBeVisible();
    expect(lastQuery(requests)).toEqual({
      typ: "bahnhoefe",
      metrik: "puenktlich",
      min_n: "500",
      gattung: "alle",
    });
    await expect(page).toHaveURL(/\/muster\/rankings$/);
  });

  test("the URL drives the request and the controls", async ({ page }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?typ=linien&k=p90&min=1000&g=fern&von=2026-01&bis=2026-03");
    await expect(column(page, WORST)).toBeVisible();
    expect(lastQuery(requests)).toEqual({
      typ: "linien",
      metrik: "p90",
      min_n: "1000",
      gattung: "fern",
      von: "2026-01",
      bis: "2026-03",
    });
    for (const name of ["1.000", "Schlechteste 10 %"])
      await expect(pressed(page, name)).toBeVisible();
    // "Linien" is also the first choice of the second switch: look in the type switch.
    await expect(kind(page).getByRole("button", { name: "Linien", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("lines or single trains: the switch writes art and the request carries it", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?typ=linien");
    const art = page.getByRole("group", { name: "Linien oder Einzelzüge" });
    await expect(column(page, WORST)).toBeVisible();
    // The default is lines: not written, not sent.
    await expect(art.getByRole("button", { name: "Linien", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(lastQuery(requests)).toEqual({
      typ: "linien",
      metrik: "puenktlich",
      min_n: "500",
      gattung: "alle",
    });
    await art.getByRole("button", { name: "Einzelzüge" }).click();
    await expect(page).toHaveURL(/[?&]typ=linien&art=zuege$/);
    await expect.poll(() => lastQuery(requests)).toMatchObject({ typ: "linien", art: "zuege" });
    await expect(art.getByRole("button", { name: "Einzelzüge" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText(/Einzelzüge mit mindestens 500 Halten/)).toBeVisible();
    // A change of the metric or the minimum keeps it.
    await page.getByRole("button", { name: "Ausfälle", exact: true }).click();
    await page.getByRole("button", { name: "1.000", exact: true }).click();
    await expect(page).toHaveURL(/[?&]art=zuege$/);
    await expect
      .poll(() => lastQuery(requests))
      .toMatchObject({ metrik: "ausfallquote", min_n: "1000", art: "zuege" });
    await art.getByRole("button", { name: "Linien", exact: true }).click();
    await expect(page).not.toHaveURL(/art=/);
    await expect.poll(() => lastQuery(requests)).not.toHaveProperty("art");
    // Stations have no such switch, and leaving the lines drops the key.
    await art.getByRole("button", { name: "Einzelzüge" }).click();
    await page.getByRole("button", { name: "Bahnhöfe", exact: true }).click();
    await expect(page).not.toHaveURL(/art=/);
    await expect(art).toHaveCount(0);
    await expect.poll(() => lastQuery(requests)).toMatchObject({ typ: "bahnhoefe" });
    expect(lastQuery(requests)).not.toHaveProperty("art");
  });

  test("an art key that is the default, invalid or on the stations is dropped", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?typ=linien&art=linien&min=1000");
    await expect(column(page, WORST)).toBeVisible();
    await expect(page).toHaveURL(/\/muster\/rankings\?typ=linien&min=1000$/);
    await page.goto("/muster/rankings?typ=linien&art=x");
    await expect(page).toHaveURL(/\/muster\/rankings\?typ=linien$/);
    await page.goto("/muster/rankings?art=zuege&k=p90");
    await expect(page).toHaveURL(/\/muster\/rankings\?k=p90$/);
    await expect(column(page, WORST)).toBeVisible();
    expect(lastQuery(requests)).toEqual({
      typ: "bahnhoefe",
      metrik: "p90",
      min_n: "500",
      gattung: "alle",
    });
    await expect(page.getByRole("group", { name: "Linien oder Einzelzüge" })).toHaveCount(0);
  });

  test("the switches write the URL and send a new request", async ({ page }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings");
    await page.getByRole("button", { name: "Linien", exact: true }).click();
    await expect(page).toHaveURL(/[?&]typ=linien/);
    await page.getByRole("button", { name: "1.000", exact: true }).click();
    await page.getByRole("button", { name: "Typische Verspätung" }).click();
    await expect(page).toHaveURL(/[?&]min=1000/);
    await expect(page).toHaveURL(/[?&]k=median/);
    await expect
      .poll(() => lastQuery(requests))
      .toMatchObject({
        typ: "linien",
        metrik: "median",
        min_n: "1000",
      });
    await expect(column(page, WORST).getByRole("listitem").first()).toContainText("RE 1");
    await expect(column(page, WORST).getByRole("listitem").first()).toContainText("9 min");
    await page.getByRole("button", { name: "Ausfälle", exact: true }).click();
    await expect.poll(() => lastQuery(requests)).toMatchObject({ metrik: "ausfallquote" });
    // The filter bar keeps the rankings keys.
    await page.getByLabel("Gattung:").selectOption("fern");
    await expect(page).toHaveURL(/[?&]g=fern/);
    await expect(page).toHaveURL(/[?&]typ=linien/);
    await expect(page).toHaveURL(/[?&]min=1000/);
    await page.getByRole("button", { name: "Bahnhöfe", exact: true }).click();
    await expect(page).not.toHaveURL(/typ=/);
    await expect.poll(() => lastQuery(requests)).toMatchObject({ typ: "bahnhoefe" });
  });

  test("invalid values and a bhf key are dropped", async ({ page }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?typ=x&min=42&bhf=8000207");
    await expect(page).toHaveURL(/\/muster\/rankings$/);
    await expect(column(page, WORST)).toBeVisible();
    expect(lastQuery(requests)).toMatchObject({ typ: "bahnhoefe", min_n: "500" });
    await expect(page.getByRole("button", { name: /^Bahnhof:/ })).toHaveCount(0);
  });

  test("station rows link to the station page and keep the filters", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?g=fern&von=2025-11&k=median&min=1000");
    const link = column(page, WORST).getByRole("link", { name: /Problemhausen Nord 0/ });
    await expect(link).toHaveAttribute("href", "/bahnhof/8000550?g=fern&von=2025-11&k=median");
    await link.click();
    await expect(page).toHaveURL(/\/bahnhof\/8000550\?g=fern&von=2025-11&k=median$/);
  });

  test("line rows show the type badge and link to the line page, keeping metric and period", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?typ=linien&g=fern&k=median&von=2025-11");
    const worst = column(page, WORST);
    await expect(
      worst.getByRole("listitem").first().getByText("RE", { exact: true }),
    ).toBeVisible();
    const link = worst.getByRole("link", { name: /RE 1/ }).first();
    // A line has one train type, so the category is not passed on.
    await expect(link).toHaveAttribute("href", "/linie/RE%201%3A8000207?von=2025-11&k=median");
    await link.click();
    await expect(page).toHaveURL(/\/linie\/RE%201%3A8000207\?von=2025-11&k=median$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("RE57");
  });

  test("a line row passes every metric on to the line page unchanged", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?typ=linien&k=p90");
    const link = column(page, WORST).getByRole("link", { name: /RE 1/ }).first();
    await expect(link).toHaveAttribute("href", "/linie/RE%201%3A8000207?k=p90");
    await page.goto("/muster/rankings?typ=linien&k=ausfall");
    await expect(link).toHaveAttribute("href", "/linie/RE%201%3A8000207?k=ausfall");
  });

  test("from 1280 px the two lists stand side by side and nothing overflows", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockApi(page);
    await page.goto("/muster/rankings");
    const worst = (await column(page, WORST).boundingBox())!;
    const best = (await column(page, BEST).boundingBox())!;
    expect(best.x).toBeGreaterThan(worst.x + worst.width - 1);
    expect(best.y).toBe(worst.y);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // Every row fits its link, so no value runs out of the card.
    const links = column(page, WORST).getByRole("link");
    const fits = await links.evaluateAll((all) => all.every((a) => a.scrollWidth <= a.clientWidth));
    expect(fits).toBe(true);
  });

  test("below 1280 px the lists stack", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await mockApi(page);
    await page.goto("/muster/rankings");
    const worst = (await column(page, WORST).boundingBox())!;
    const best = (await column(page, BEST).boundingBox())!;
    expect(best.y).toBeGreaterThan(worst.y + worst.height - 1);
    expect(best.x).toBe(worst.x);
  });

  test("the sidebar marks Rankings and the filter bar has no station chip", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?g=fern");
    const link = page
      .getByRole("navigation", { name: "Hauptnavigation" })
      .getByRole("link", { name: "Rankings" });
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(link).toHaveAttribute("href", "/muster/rankings?g=fern");
    await expect(page.getByRole("button", { name: /^Bahnhof:/ })).toHaveCount(0);
    await expect(page.getByLabel("Gattung:")).toHaveValue("fern");
  });

  test("the type switch has four values; sections and records hide the metric switch and keep k", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?k=p90");
    await expect(kind(page).getByRole("button")).toHaveText([
      "Linien",
      "Bahnhöfe",
      "Abschnitte",
      "Rekorde",
    ]);
    const metric = page.getByRole("group", { name: "Kennzahl" });
    await expect(metric).toBeVisible();
    await kind(page).getByRole("button", { name: "Abschnitte" }).click();
    await expect(page).toHaveURL(/\/muster\/rankings\?k=p90&typ=abschnitte$/);
    await expect(column(page, LOSE).getByRole("listitem")).toHaveCount(10);
    await expect(metric).toHaveCount(0);
    expect(lastOf(requests, "/rankings/abschnitte")).toEqual({ min_n: "500", gattung: "alle" });
    await kind(page).getByRole("button", { name: "Rekorde" }).click();
    await expect(page).toHaveURL(/\/muster\/rankings\?k=p90&typ=rekorde$/);
    await expect(column(page, MOST).getByRole("listitem")).toHaveCount(10);
    await expect(metric).toHaveCount(0);
    expect(lastOf(requests, "/rankings/rekorde")).toEqual({
      art: "halte",
      min_n: "15",
      gattung: "alle",
    });
    await kind(page).getByRole("button", { name: "Linien", exact: true }).click();
    await expect(page).toHaveURL(/\/muster\/rankings\?k=p90&typ=linien$/);
    await expect(pressed(page, "Schlechteste 10 %")).toBeVisible();
    await expect.poll(() => lastQuery(requests)).toMatchObject({ typ: "linien", metrik: "p90" });
  });

  test("sections: two columns with the stations, the counts, the minutes in their step colour", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto(
      "/muster/rankings?g=fern&von=2026-01&bis=2026-03&k=median&typ=abschnitte&min=1000",
    );
    const worst = column(page, LOSE);
    const best = column(page, MAKE_UP);
    await expect(worst.getByRole("listitem")).toHaveCount(10);
    await expect(best.getByRole("listitem")).toHaveCount(10);
    expect(lastOf(requests, "/rankings/abschnitte")).toEqual({
      min_n: "1000",
      gattung: "fern",
      von: "2026-01",
      bis: "2026-03",
    });
    expect(requests.some((u) => u.pathname === "/rankings")).toBe(false);
    const first = worst.getByRole("listitem").first();
    for (const text of [
      "1",
      "Verlustvon 0 → Verlustnach 0",
      "1.500 Fahrten",
      "76 Linien",
      "+14,3 min",
      "73 weitere",
    ])
      await expect(first).toContainText(text);
    await expect(first.locator("i")).toHaveCSS("background-color", R5);
    const top = best.getByRole("listitem").first();
    await expect(top).toContainText("Gewinnvon 0 → Gewinnnach 0");
    await expect(top).toContainText("−20,2 min");
    await expect(top.locator("i")).toHaveCSS("background-color", R1);
    await expect(worst.getByRole("listitem").nth(9)).toContainText("+4,4 min");
    // One line is "1 Linie", and nothing is left over when all lines are named.
    const second = worst.getByRole("listitem").nth(1);
    await expect(second).toContainText("1 Linie");
    await expect(second).not.toContainText("weitere");
    await expect(second.getByRole("link")).toHaveCount(1);
    const third = worst.getByRole("listitem").nth(2);
    await expect(third).toContainText("3 Linien");
    await expect(third).not.toContainText("weitere");
    await expect(pressed(page, "1.000")).toBeVisible();
    // The fixture counts 14,211 sections for all trains and 3,000 for one category.
    const meta = page.getByText(/3\.000 Abschnitte mit mindestens 1\.000 Fahrten/);
    await expect(meta).toContainText("Sept. 2026");
    // The station switches are not on this tab.
    await expect(page.getByRole("group", { name: "Linien oder Einzelzüge" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Halte oder Züge" })).toHaveCount(0);
  });

  test("the step colour of a section follows the same limits as the line page", async ({
    page,
  }) => {
    await mockApi(page, ...DEFAULTS, (g, minN) => {
      const data = abschnitteRanglisteFixture(g, minN);
      return {
        ...data,
        schlechteste: [{ ...data.schlechteste[0], minuten: 0.5 }, ...data.schlechteste.slice(1)],
        beste: [{ ...data.beste[0], minuten: -0.3 }, ...data.beste.slice(1)],
      };
    });
    await page.goto("/muster/rankings?typ=abschnitte");
    const lose = column(page, LOSE).getByRole("listitem").first();
    await expect(lose).toContainText("+0,5 min");
    await expect(lose.locator("i")).toHaveCSS("background-color", R4);
    const make = column(page, MAKE_UP).getByRole("listitem").first();
    await expect(make).toContainText("−0,3 min");
    await expect(make.locator("i")).toHaveCSS("background-color", R2);
  });

  test("a section's line links open the line page on that section, or without one when its usual route lacks it", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?von=2026-01&bis=2026-03&k=median&typ=abschnitte");
    const links = column(page, LOSE).getByRole("listitem").first().getByRole("link");
    await expect(links).toHaveCount(3);
    // Direction 1 is the default and not written.
    await expect(links.nth(0)).toHaveText("ICE 50 Hamburg Hbf – München Hbf");
    await expect(links.nth(0)).toHaveAttribute(
      "href",
      "/linie/ICE%2050%3A8000207?von=2026-01&bis=2026-03&abschnitt=8000100-8000200&k=median",
    );
    await expect(links.nth(1)).toHaveAttribute(
      "href",
      "/linie/RE%201%3A8000207?von=2026-01&bis=2026-03&richtung=2&abschnitt=8000100-8000200&k=median",
    );
    // No direction: the usual route lacks the section, so the line page opens without a selection.
    await expect(links.nth(2)).toHaveAttribute(
      "href",
      "/linie/IC%202%3A8000207?von=2026-01&bis=2026-03&k=median",
    );
    await links.nth(2).click();
    await expect(page).toHaveURL(/\/linie\/IC%202%3A8000207\?von=2026-01&bis=2026-03&k=median$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("RE57");
  });

  test("a section link opens the line page with that section selected in its direction", async ({
    page,
  }) => {
    // Warburg → Soest, the first section of the line's direction 2.
    const pair = "08000718-08000367";
    await mockApi(page, ...DEFAULTS, (g, minN) => {
      const data = abschnitteRanglisteFixture(g, minN);
      const [first, ...rest] = data.schlechteste;
      const linien = [
        {
          id: LINE_ID,
          label: "RE57 Dortmund Hbf – Warburg (Westf)",
          n: 5800,
          richtung: 2 as const,
        },
      ];
      return {
        ...data,
        schlechteste: [{ ...first, von_eva: "08000718", nach_eva: "08000367", linien }, ...rest],
      };
    });
    await page.goto("/muster/rankings?typ=abschnitte");
    await column(page, LOSE)
      .getByRole("listitem")
      .first()
      .getByRole("link", { name: "RE57 Dortmund Hbf – Warburg (Westf)" })
      .click();
    // The URL keeps the direction and the pair after the line page has cleaned it.
    await expect(page.getByRole("heading", { level: 1 })).toContainText("RE57");
    await expect(page).toHaveURL(new RegExp(`richtung=2&abschnitt=${pair}$`));
    await expect(page.getByTestId("line-map")).toHaveAttribute("data-selected", pair);
    await expect(page.getByTestId("section").first().getByRole("button")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("records of stations: stops per day, the sample and the link to the station", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?g=fern&von=2025-11&k=median&typ=rekorde");
    const most = column(page, MOST);
    const fewest = column(page, FEWEST);
    await expect(most.getByRole("listitem")).toHaveCount(10);
    await expect(fewest.getByRole("listitem")).toHaveCount(10);
    // Halte is the default: not written, but sent.
    expect(lastOf(requests, "/rankings/rekorde")).toEqual({
      art: "halte",
      min_n: "15",
      gattung: "fern",
      von: "2025-11",
    });
    const first = most.getByRole("listitem").first();
    for (const text of ["1", "Knoten 0", "n = 48.540", "1.618 Halte/Tag"])
      await expect(first).toContainText(text);
    await expect(most.getByRole("listitem").nth(9)).toContainText("718 Halte/Tag");
    // One decimal below 10 stops a day, whole numbers from there.
    await expect(fewest.getByRole("listitem").first()).toContainText("3,2 Halte/Tag");
    await expect(fewest.getByRole("listitem").nth(9)).toContainText("4,1 Halte/Tag");
    await expect(first.getByRole("link")).toHaveAttribute(
      "href",
      "/bahnhof/8000700?g=fern&von=2025-11&k=median",
    );
    const halte = page.getByRole("group", { name: "Halte oder Züge" });
    await expect(halte.getByRole("button")).toHaveText(["Halte", "Züge"]);
    await expect(halte.getByRole("button", { name: "Halte" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText(/2\.445 Bahnhöfe mit mindestens 15 Halten/)).toBeVisible();
  });

  test("records of lines: the Züge switch writes rekord, trains per hour with their decimals", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?von=2025-11&k=median&typ=rekorde");
    await expect(column(page, MOST).getByRole("listitem")).toHaveCount(10);
    const art = page.getByRole("group", { name: "Halte oder Züge" });
    await art.getByRole("button", { name: "Züge" }).click();
    await expect(page).toHaveURL(
      /\/muster\/rankings\?von=2025-11&k=median&typ=rekorde&rekord=takt$/,
    );
    await expect
      .poll(() => lastOf(requests, "/rankings/rekorde"))
      .toEqual({ art: "takt", min_n: "15", gattung: "alle", von: "2025-11" });
    const most = column(page, MOST).getByRole("listitem");
    await expect(most.first()).toContainText("S 1 Hamburg Hbf – Wedel");
    await expect(most.first()).toContainText("29,4 Züge/h");
    // The second line gives trains a day (value × 16) instead of the stops: whole numbers from 10.
    await expect(most.first()).toContainText("≈ 470 Züge am Tag");
    await expect(most.first()).not.toContainText("n = ");
    await expect(most.nth(1)).toContainText("27,9 Züge/h");
    // Below one train an hour two decimals, from one on one; a day's trains with one decimal below 10.
    const fewest = column(page, FEWEST).getByRole("listitem");
    await expect(fewest.nth(0)).toContainText("0,06 Züge/h");
    await expect(fewest.nth(0)).toContainText("≈ 1,0 Züge am Tag");
    await expect(fewest.nth(1)).toContainText("0,08 Züge/h");
    await expect(fewest.nth(1)).toContainText("≈ 1,3 Züge am Tag");
    await expect(fewest.nth(5)).toContainText("1,0 Züge/h");
    await expect(fewest.nth(5)).toContainText("≈ 16 Züge am Tag");
    await expect(page.getByText(/mindestens einen Zug am Tag/)).toBeVisible();
    await expect(most.first().getByRole("link")).toHaveAttribute(
      "href",
      "/linie/S%201%3A8000207?von=2025-11&k=median",
    );
    await expect(page.getByText(/2\.445 Linien mit mindestens 15 Halten/)).toBeVisible();
    // The metric keeps it; Halte writes nothing.
    await art.getByRole("button", { name: "Halte" }).click();
    await expect(page).toHaveURL(/typ=rekorde$/);
    await expect.poll(() => lastOf(requests, "/rankings/rekorde")).toMatchObject({ art: "halte" });
  });

  test("records take no minimum: no chips, the request carries the floor, min survives a tab change", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?typ=rekorde&min=1000");
    await expect(column(page, MOST).getByRole("listitem")).toHaveCount(10);
    await expect(page.getByRole("group", { name: "Mindest-Stichprobe" })).toHaveCount(0);
    await expect(page.getByText("Mindest-Stichprobe")).toHaveCount(0);
    expect(lastOf(requests, "/rankings/rekorde")).toMatchObject({ min_n: "15" });
    await page.getByRole("group", { name: "Halte oder Züge" }).getByText("Züge").click();
    await expect(page).toHaveURL(/typ=rekorde&min=1000&rekord=takt$/);
    await expect.poll(() => lastOf(requests, "/rankings/rekorde")).toMatchObject({ min_n: "15" });
    await kind(page).getByRole("button", { name: "Bahnhöfe" }).click();
    await expect(page).toHaveURL(/\/muster\/rankings\?min=1000$/);
    await expect(pressed(page, "1.000")).toBeVisible();
    await expect.poll(() => lastQuery(requests)).toMatchObject({ min_n: "1000" });
  });

  test("each tab explains its numbers under the controls", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?typ=abschnitte");
    await expect(
      page.getByText(
        /Mittlere Änderung der Verspätung je Fahrt zwischen zwei aufeinanderfolgenden Halten/,
      ),
    ).toBeVisible();
    await expect(page.getByText(/Die Mindest-Stichprobe zählt Fahrten\./)).toBeVisible();
    await kind(page).getByRole("button", { name: "Rekorde" }).click();
    await expect(page.getByText(/Halte pro Kalendertag der Monate mit Daten/)).toBeVisible();
    await expect(
      page.getByText(/Ein Bahnhof braucht mindestens 15 Halte im Zeitraum\./),
    ).toBeVisible();
    await expect(page.getByText(/Mittlere Änderung der Verspätung/)).toHaveCount(0);
    await page.getByRole("group", { name: "Halte oder Züge" }).getByText("Züge").click();
    await expect(page.getByText(/zwischen 6:00 und 21:59 Uhr starten/)).toBeVisible();
    await expect(page.getByText(/geteilt durch 16/)).toBeVisible();
    await expect(
      page.getByText(
        /Eine Linie braucht mindestens 15 Halte im Zeitraum und im Schnitt mindestens einen Zug am Tag zwischen 6:00 und 21:59 Uhr\./,
      ),
    ).toBeVisible();
    await expect(page.getByText(/Halte pro Kalendertag/)).toHaveCount(0);
    await kind(page).getByRole("button", { name: "Linien", exact: true }).click();
    await expect(page.getByText(/geteilt durch 16/)).toHaveCount(0);
  });

  test("the keys of the new tabs that do not apply are dropped", async ({ page }) => {
    await mockApi(page);
    for (const [from, to] of [
      ["?rekord=takt", "/muster/rankings"],
      ["?typ=linien&rekord=takt", "/muster/rankings?typ=linien"],
      ["?typ=abschnitte&rekord=takt&art=zuege", "/muster/rankings?typ=abschnitte"],
      ["?typ=rekorde&rekord=halte", "/muster/rankings?typ=rekorde"],
      ["?typ=rekorde&rekord=x&art=zuege", "/muster/rankings?typ=rekorde"],
      ["?typ=rekorde&rekord=takt", "/muster/rankings?typ=rekorde&rekord=takt"],
    ])
      await test.step(from, async () => {
        await page.goto(`/muster/rankings${from}`);
        await expect(page).toHaveURL(to);
      });
  });

  test("a threshold nobody reaches shows the empty state on both new tabs", async ({ page }) => {
    await mockApi(
      page,
      ...DEFAULTS,
      (g, minN) => ({
        ...abschnitteRanglisteFixture(g, minN),
        von: "",
        bis: "",
        anzahl: 0,
        schlechteste: [],
        beste: [],
      }),
      (art, minN) => ({
        ...rekordeFixture(art, minN),
        von: "",
        bis: "",
        anzahl: 0,
        meiste: [],
        wenigste: [],
      }),
    );
    await page.goto("/muster/rankings?typ=abschnitte&min=5000");
    await expect(page.getByText("Keine Abschnitte mit mindestens 5.000 Fahrten")).toBeVisible();
    await expect(page.getByText(/Eine kleinere Mindest-Stichprobe/)).toBeVisible();
    await expect(page.getByText(/Abschnitte mit mindestens 5\.000 Fahrten ·/)).toHaveCount(0);
    await page.goto("/muster/rankings?typ=rekorde&min=5000");
    await expect(page.getByText("Keine Einträge mit mindestens 15 Halten")).toBeVisible();
  });

  test("the error state of a new tab recovers on retry", async ({ page }) => {
    let calls = 0;
    await mockApi(page, ...DEFAULTS, (g, minN) =>
      calls++ === 0 ? null : abschnitteRanglisteFixture(g, minN),
    );
    await page.goto("/muster/rankings?typ=abschnitte&g=fern");
    await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    await expect(column(page, LOSE).getByRole("listitem")).toHaveCount(10);
    await expect(page).toHaveURL(/typ=abschnitte/);
  });

  test("the section lists stand side by side from 1280 px, stack below, and nothing overflows", async ({
    page,
  }) => {
    await mockApi(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/muster/rankings?typ=abschnitte");
    await expect(column(page, LOSE).getByRole("listitem")).toHaveCount(10);
    await expect(column(page, MAKE_UP).getByRole("listitem")).toHaveCount(10);
    await fontsReady(page);
    const lose = (await column(page, LOSE).boundingBox())!;
    const make = (await column(page, MAKE_UP).boundingBox())!;
    expect(make.x).toBeGreaterThan(lose.x + lose.width - 1);
    expect(make.y).toBe(lose.y);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    expect(await noScroll(page)).toBe(true);
    await page.setViewportSize({ width: 1024, height: 800 });
    const above = (await column(page, LOSE).boundingBox())!;
    const below = (await column(page, MAKE_UP).boundingBox())!;
    expect(below.y).toBeGreaterThan(above.y + above.height - 1);
    expect(below.x).toBe(above.x);
    expect(await noScroll(page)).toBe(true);
  });

  test("show more: a click asks for 110, grows that list only and counts it; each list counts on its own", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings");
    const worst = column(page, WORST);
    const best = column(page, BEST);
    await expect(worst.getByText("10 von 2.445")).toBeVisible();
    await expect(best.getByText("10 von 2.445")).toBeVisible();
    expect(lastQuery(requests)).not.toHaveProperty("limit");
    const button = more(worst);
    // The polite live region speaks only after a click in its own list, never on load.
    const live = worst.locator('[aria-live="polite"]');
    await expect(live).toHaveText("");
    await button.click();
    await expect(worst.getByRole("listitem")).toHaveCount(110);
    await expect(worst.getByText("110 von 2.445")).toBeVisible();
    await expect(live).toHaveText("110 Einträge angezeigt");
    await expect(best.locator('[aria-live="polite"]')).toHaveText("");
    expect(lastQuery(requests)).toMatchObject({ limit: "110" });
    // Rank numbers keep counting, and the button keeps the focus.
    await expect(worst.getByRole("listitem").last()).toContainText("110");
    await expect(button).toBeFocused();
    await expect(best.getByRole("listitem")).toHaveCount(10);
    await expect(best.getByText("10 von 2.445")).toBeVisible();
    // The other list has its own count; the request already holds its 110 rows.
    const before = rankingRequests(requests).length;
    await more(best).click();
    await expect(best.getByRole("listitem")).toHaveCount(110);
    expect(rankingRequests(requests)).toHaveLength(before);
    // The next click on the first list asks for more and leaves the second at 110.
    await button.click();
    await expect(worst.getByRole("listitem")).toHaveCount(210);
    expect(lastQuery(requests)).toMatchObject({ limit: "210" });
    await expect(worst.getByText("210 von 2.445")).toBeVisible();
    await expect(best.getByRole("listitem")).toHaveCount(110);
    await expect(page).not.toHaveURL(/limit|shown/);
  });

  test("show more: the last click shows every row and removes the button and the count", async ({
    page,
  }) => {
    const requests = await mockApi(page, undefined, undefined, undefined, (typ, metrik, minN) => ({
      ...rankingFixture(typ, metrik, minN),
      anzahl: 25,
    }));
    await page.goto("/muster/rankings");
    const worst = column(page, WORST);
    await expect(worst.getByText("10 von 25")).toBeVisible();
    await more(worst).click();
    await expect(worst.getByRole("listitem")).toHaveCount(25);
    expect(lastQuery(requests)).toMatchObject({ limit: "110" });
    await expect(more(worst)).toHaveCount(0);
    await expect(worst.getByText(/ von /)).toHaveCount(0);
    // The button is gone, so the focus moves to the first row that was added.
    await expect(worst.getByRole("listitem").nth(10).getByRole("link")).toBeFocused();
    // The other list is still at ten and keeps its button.
    await expect(column(page, BEST).getByRole("listitem")).toHaveCount(10);
    await expect(more(column(page, BEST))).toBeVisible();
  });

  test("show more: a filter, the metric or the tab returns both lists to ten and drops the limit", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings");
    const worst = column(page, WORST);
    for (const change of [
      () => page.getByRole("button", { name: "Typische Verspätung" }).click(),
      () => page.getByRole("button", { name: "1.000", exact: true }).click(),
      () => page.getByLabel("Gattung:").selectOption("fern"),
      () => page.getByRole("button", { name: "Linien", exact: true }).click(),
    ])
      await test.step(`${change}`, async () => {
        await more(worst).click();
        await expect(worst.getByRole("listitem")).toHaveCount(110);
        const asked = rankingRequests(requests).length;
        await change();
        await expect.poll(() => rankingRequests(requests).length).toBeGreaterThan(asked);
        await expect(worst.getByRole("listitem")).toHaveCount(10);
        await expect(worst.getByText("10 von 2.445")).toBeVisible();
        await expect(worst.locator('[aria-live="polite"]')).toHaveText("");
        expect(lastQuery(requests)).not.toHaveProperty("limit");
      });
  });

  test("show more: the last click on sections moves the focus to the first added row", async ({
    page,
  }) => {
    await mockApi(page, ...DEFAULTS, (g, minN) => ({
      ...abschnitteRanglisteFixture(g, minN),
      anzahl: 25,
    }));
    await page.goto("/muster/rankings?typ=abschnitte");
    const lose = column(page, LOSE);
    await more(lose).click();
    await expect(lose.getByRole("listitem")).toHaveCount(25);
    await expect(more(lose)).toHaveCount(0);
    await expect(lose.getByRole("listitem").nth(10)).toBeFocused();
  });

  test("show more: the sections lists have the button, the count and the limit", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?typ=abschnitte");
    const lose = column(page, LOSE);
    await expect(lose.getByText("10 von 14.211")).toBeVisible();
    expect(lastOf(requests, "/rankings/abschnitte")).not.toHaveProperty("limit");
    await more(lose).click();
    await expect(lose.getByRole("listitem")).toHaveCount(110);
    await expect(lose.getByText("110 von 14.211")).toBeVisible();
    expect(lastOf(requests, "/rankings/abschnitte")).toMatchObject({ limit: "110" });
    await expect(lose.getByRole("listitem").last()).toContainText("110");
    await expect(column(page, MAKE_UP).getByRole("listitem")).toHaveCount(10);
    await expect(more(column(page, MAKE_UP))).toBeVisible();
  });

  test("show more: the records lists have the button, and the Halte or Züge switch starts over", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings?typ=rekorde");
    const most = column(page, MOST);
    await expect(most.getByText("10 von 2.445")).toBeVisible();
    await expect(more(column(page, FEWEST))).toBeVisible();
    await more(most).click();
    await expect(most.getByRole("listitem")).toHaveCount(110);
    expect(lastOf(requests, "/rankings/rekorde")).toMatchObject({ art: "halte", limit: "110" });
    await page.getByRole("group", { name: "Halte oder Züge" }).getByText("Züge").click();
    await expect(most.getByRole("listitem").first()).toContainText("Züge/h");
    await expect(most.getByRole("listitem")).toHaveCount(10);
    await expect(most.getByText("10 von 2.445")).toBeVisible();
    expect(lastOf(requests, "/rankings/rekorde")).not.toHaveProperty("limit");
  });

  test("show more: going back to the earlier query starts at ten again", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings");
    const worst = column(page, WORST);
    await more(worst).click();
    await expect(worst.getByRole("listitem")).toHaveCount(110);
    await page.getByRole("button", { name: "Typische Verspätung" }).click();
    await expect(worst.getByRole("listitem")).toHaveCount(10);
    await page.getByRole("button", { name: "Pünktlichkeit", exact: true }).click();
    await expect(worst.getByRole("listitem")).toHaveCount(10);
    await expect(worst.getByText("10 von 2.445")).toBeVisible();
  });
});

test("the column header names the value bold and the grey cancellation column", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/muster/rankings");
  const worst = column(page, WORST);
  await expect(worst.getByRole("listitem")).toHaveCount(10);
  const metric = worst.getByText("Pünktlichkeit", { exact: true });
  await expect(metric).toBeVisible();
  const weight = await metric.evaluate((el) => Number(getComputedStyle(el).fontWeight));
  expect(weight).toBeGreaterThanOrEqual(600);
  const cancelled = worst.getByText("Ausfälle", { exact: true });
  await expect(cancelled).toBeVisible();
  await expect(cancelled).toHaveCSS("color", CANCEL);
  // It sits right above the grey figures: the same right edge as the first row's.
  const head = (await cancelled.boundingBox())!;
  const cell = (await worst.getByText("✕ 8,0 %").boundingBox())!;
  expect(Math.abs(head.x + head.width - (cell.x + cell.width))).toBeLessThanOrEqual(1);
  expect(head.y).toBeLessThan(cell.y);
});

test("a cancellation rate of 10 % or more stays on one line", async ({ page }) => {
  await mockApi(page, undefined, undefined, undefined, (typ, metrik, minN) => {
    const data = rankingFixture(typ, metrik, minN);
    const [first, ...rest] = data.schlechteste;
    return { ...data, schlechteste: [{ ...first, ausfallquote: 0.109 }, ...rest] };
  });
  await page.goto("/muster/rankings");
  const worst = column(page, WORST);
  const cell = worst.getByText("✕ 10,9 %");
  await expect(cell).toBeVisible();
  // One line of 12 px text is 16 px high; a wrapped cell would be twice that.
  expect((await cell.boundingBox())!.height).toBeLessThan(20);
  const link = worst.getByRole("link").first();
  expect(await link.evaluate((a) => a.scrollWidth <= a.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a threshold nobody reaches shows an empty state", async ({ page }) => {
  await mockApi(page, undefined, undefined, undefined, emptyRangliste);
  await page.goto("/muster/rankings?min=5000");
  await expect(page.getByText("Keine Einträge mit mindestens 5.000 Halten")).toBeVisible();
  await expect(page.getByText(/Eine kleinere Mindest-Stichprobe/)).toBeVisible();
  await page.getByRole("button", { name: "100", exact: true }).click();
  await expect(page).toHaveURL(/[?&]min=100/);
});

test("the error state keeps the filters and recovers on retry", async ({ page }) => {
  let calls = 0;
  await mockApi(page, undefined, undefined, undefined, (typ, metrik, minN) =>
    calls++ === 0 ? null : rankingFixture(typ, metrik, minN),
  );
  await page.goto("/muster/rankings?g=fern");
  await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(column(page, WORST).getByRole("listitem")).toHaveCount(10);
  await expect(page).toHaveURL(/[?&]g=fern/);
});

test("Teilen copies the link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page);
  await page.goto("/muster/rankings?typ=linien");
  await page.getByRole("button", { name: "Teilen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link kopiert" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/typ=linien$/);
});

test("the type switch stays where it is on every tab", async ({ page, isMobile }) => {
  await page.setViewportSize(isMobile ? { width: 375, height: 812 } : { width: 1280, height: 800 });
  await mockApi(page);
  const boxes = [];
  for (const typ of ["linien", "bahnhoefe", "abschnitte", "rekorde"]) {
    await page.goto(`/muster/rankings?typ=${typ}`);
    await expect(page.getByRole("listitem").first()).toBeVisible();
    await fontsReady(page);
    const b = (await kind(page).boundingBox())!;
    boxes.push({ x: b.x, y: b.y, width: b.width });
  }
  for (const b of boxes) expect(b).toEqual(boxes[0]);
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("the two columns are tabs", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings");
    const worstTab = page.getByRole("tab", { name: WORST });
    const bestTab = page.getByRole("tab", { name: BEST });
    await expect(worstTab).toHaveAttribute("aria-selected", "true");
    await expect(column(page, WORST).getByRole("listitem")).toHaveCount(10);
    await expect(column(page, BEST)).toHaveCount(0);
    await bestTab.click();
    await expect(bestTab).toHaveAttribute("aria-selected", "true");
    await expect(column(page, BEST).getByRole("listitem")).toHaveCount(10);
    await expect(column(page, WORST)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("show more: the shown tab grows, the other keeps its ten, and the button has a 44 px hit area", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto("/muster/rankings");
    const worst = column(page, WORST);
    const button = more(worst);
    await expect(worst.getByText("10 von 2.445")).toBeVisible();
    // A tap 21 px above and below the centre still lands on the button.
    const hit = await button.evaluate((el) => {
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return [-21, 21].every((dy) => el.contains(document.elementFromPoint(x, y + dy)));
    });
    expect(hit).toBe(true);
    await button.click();
    await expect(worst.getByRole("listitem")).toHaveCount(110);
    expect(lastQuery(requests)).toMatchObject({ limit: "110" });
    await page.getByRole("tab", { name: BEST }).click();
    await expect(column(page, BEST).getByRole("listitem")).toHaveCount(10);
    await expect(column(page, BEST).getByText("10 von 2.445")).toBeVisible();
    await page.getByRole("tab", { name: WORST }).click();
    await expect(column(page, WORST).getByRole("listitem")).toHaveCount(110);
    expect(await noScroll(page)).toBe(true);
  });

  test("the lines or single trains switch fits the phone and has 44 px hit areas", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?typ=linien");
    await expect(column(page, WORST)).toBeVisible();
    const art = page.getByRole("group", { name: "Linien oder Einzelzüge" });
    for (const name of ["Linien", "Einzelzüge"]) {
      const b = (await art.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(b.x, name).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, name).toBeLessThanOrEqual(page.viewportSize()!.width);
      // A tap 21 px above and below the centre still lands on the button.
      const hit = await art.getByRole("button", { name, exact: true }).evaluate((el) => {
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return [-21, 21].every((dy) => el.contains(document.elementFromPoint(x, y + dy)));
      });
      expect(hit, name).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("the section and record columns are tabs, and the Halte or Züge switch stays inside", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?typ=abschnitte");
    await expect(page.getByRole("tab", { name: LOSE })).toHaveAttribute("aria-selected", "true");
    await expect(column(page, LOSE).getByRole("listitem")).toHaveCount(10);
    await expect(column(page, MAKE_UP)).toHaveCount(0);
    await page.getByRole("tab", { name: MAKE_UP }).click();
    await expect(column(page, MAKE_UP).getByRole("listitem")).toHaveCount(10);
    await expect(column(page, LOSE)).toHaveCount(0);
    expect(await noScroll(page)).toBe(true);
    // The records start on their first column, whichever tab the sections had open.
    await kind(page).getByRole("button", { name: "Rekorde" }).click();
    await expect(page.getByRole("tab", { name: MOST })).toHaveAttribute("aria-selected", "true");
    await expect(column(page, MOST).getByRole("listitem")).toHaveCount(10);
    await page.getByRole("tab", { name: FEWEST }).click();
    await expect(column(page, FEWEST).getByRole("listitem")).toHaveCount(10);
    expect(await noScroll(page)).toBe(true);
  });

  test("the four-way switch fits 375 px without a horizontal scroll and has 44 px hit areas", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockApi(page);
    for (const search of ["", "?typ=linien", "?typ=rekorde", "?typ=rekorde&rekord=takt"]) {
      await page.goto(`/muster/rankings${search}`);
      await expect(page.getByRole("listitem").first()).toBeVisible();
      expect(await noScroll(page), search).toBe(true);
    }
    await page.goto("/muster/rankings?typ=rekorde");
    await expect(column(page, MOST)).toBeVisible();
    for (const [group, name] of [
      [kind(page), "Linien"],
      [kind(page), "Bahnhöfe"],
      [kind(page), "Abschnitte"],
      [kind(page), "Rekorde"],
      [page.getByRole("group", { name: "Halte oder Züge" }), "Halte"],
      [page.getByRole("group", { name: "Halte oder Züge" }), "Züge"],
    ] as const) {
      const button = group.getByRole("button", { name, exact: true });
      // A tap 21 px above and below the centre still lands on the button.
      const hit = await button.evaluate((el) => {
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return [-21, 21].every((dy) => el.contains(document.elementFromPoint(x, y + dy)));
      });
      expect(hit, name).toBe(true);
    }
    expect(await noScroll(page)).toBe(true);
  });

  test("the line links of a section row do not steal each other's taps", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?typ=abschnitte");
    const links = column(page, LOSE).getByRole("listitem").first().getByRole("link");
    await expect(links).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      // A tap at the centre and 10 px above and below it lands on the link itself.
      const hit = await links.nth(i).evaluate((el) => {
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return [-10, 0, 10].every((dy) => el.contains(document.elementFromPoint(x, y + dy)));
      });
      expect(hit, `link ${i}`).toBe(true);
    }
  });

  test("small controls have a hit area of at least 44 px", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings");
    await expect(column(page, WORST)).toBeVisible();
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
      page.getByRole("navigation", { name: "Muster", exact: true }).getByRole("link", {
        name: "Heatmap",
      }),
      page.getByRole("tab", { name: BEST }),
      page.getByRole("button", { name: "Linien", exact: true }),
      page.getByRole("button", { name: "1.000", exact: true }),
      page.getByRole("button", { name: "Ausfälle", exact: true }),
      page.getByRole("button", { name: "Teilen" }),
      column(page, WORST).getByRole("link").first(),
    ];
    for (const c of controls) expect(await tall(c), `${await c.textContent()}`).toBe(true);
  });
});

for (const [locale, worst, label, metric, figure] of [
  ["de-DE", WORST, "Ausfälle", "Pünktlichkeit", "✕ 10,9 %"],
  ["en-US", "Least reliable", "Cancellations", "Punctuality", "✕ 10.9%"],
] as const)
  test.describe(`the cancellation column in ${locale}`, () => {
    test.use({ locale });

    test("its label stays on one line and lines up with the figures at every width", async ({
      page,
      isMobile,
    }) => {
      await mockApi(page, undefined, undefined, undefined, (typ, metrik, minN) => {
        const data = rankingFixture(typ, metrik, minN);
        const [first, ...rest] = data.schlechteste;
        return { ...data, schlechteste: [{ ...first, ausfallquote: 0.109 }, ...rest] };
      });
      // Two cards from 1280 px, stacked below, and the phone project's own size with tabs.
      for (const width of isMobile ? [0] : [1280, 1024, 900, 768]) {
        if (width) await page.setViewportSize({ width, height: 800 });
        await page.goto("/muster/rankings");
        const card = column(page, worst);
        const head = card.getByText(label, { exact: true });
        const cell = card.getByText(figure);
        await expect(cell).toBeVisible();
        // The text's own box: an element box would hide text that runs out of a narrow cell.
        const ink = (l: Locator) =>
          l.evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const { x, width, height } = range.getBoundingClientRect();
            return { x, width, height };
          });
        const [h, c, m, box] = await Promise.all([
          ink(head),
          ink(cell),
          ink(card.getByText(metric, { exact: true })),
          card.boundingBox(),
        ]);
        const at = `${locale} ${width || "mobile"}`;
        expect(h.height, at).toBeLessThan(20);
        expect(Math.abs(h.x + h.width - (c.x + c.width)), at).toBeLessThanOrEqual(2);
        expect(m.x + m.width, at).toBeLessThanOrEqual(h.x);
        expect(h.x + h.width, at).toBeLessThanOrEqual(box!.x + box!.width);
        const fits = await card
          .getByRole("link")
          .evaluateAll((all) => all.every((a) => a.scrollWidth <= a.clientWidth));
        expect(fits, at).toBe(true);
      }
    });
  });

test.describe("the new tabs in English", () => {
  test.use({ locale: "en-US" });

  test("sections and records read in English with their own number formats", async ({
    page,
    isMobile,
  }) => {
    await mockApi(page);
    // On a phone only one of the two columns is shown.
    const open = async (name: string) => {
      if (isMobile) await page.getByRole("tab", { name, exact: true }).click();
      return column(page, name).getByRole("listitem").first();
    };
    await page.goto("/muster/rankings?typ=abschnitte");
    const lose = await open("Lose the most time");
    await expect(lose).toContainText("Verlustvon 0 → Verlustnach 0");
    await expect(lose).toContainText("+14.3 min");
    await expect(lose).toContainText("73 more");
    await expect(await open("Make up the most")).toContainText("−20.2 min");
    await expect(page.getByText(/Mean change of the delay per trip/)).toBeVisible();
    await expect(page.getByText(/14,211 sections with at least 500 trips/)).toBeVisible();
    await page.getByRole("button", { name: "Records" }).click();
    await expect(await open("The most")).toContainText("1,618 stops/day");
    await page.getByRole("group", { name: "Stops or trains" }).getByText("Trains").click();
    await expect(await open("The most")).toContainText("29.4 trains/h");
    await expect(await open("The fewest")).toContainText("0.06 trains/h");
    await expect(await open("The fewest")).toContainText("≈ 1.0 trains a day");
    await expect(page.getByText(/at least one train a day/)).toBeVisible();
    await expect(page.getByText(/divided by 16/)).toBeVisible();
  });
});

test("after 5 seconds the skeleton says the server is starting, and counts the seconds", async ({
  page,
}) => {
  await mockApi(page);
  await page.route(
    (url) => url.pathname === "/rankings",
    () => new Promise(() => {}),
  );
  await page.clock.install();
  await page.goto("/muster/rankings");
  const hint = page.getByText(/Der Server startet gerade \(\d+ s\)/);
  await page.clock.fastForward(4000);
  await expect(hint).toHaveCount(0);
  await page.clock.fastForward(1500);
  await expect(hint).toContainText(/\([56] s\), das kann bis zu einer Minute dauern\./);
  await page.clock.fastForward(3000);
  await expect(hint).toContainText(/\((8|9|10) s\)/);
});
