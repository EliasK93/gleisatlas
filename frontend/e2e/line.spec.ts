import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  abschnitteFixture,
  FAHRPLAN_BIS,
  FAHRPLAN_VON,
  fahrplanFixture,
  fontsReady,
  LINE_ID,
  LINE_PATH,
  lineFixture,
  mockApi,
  NOT_FOUND,
  queryOf,
} from "./fixtures";

// The step colours of theme.css as hex (the map reads the tokens) and as the browser reports them.
const LIGHT = ["#2166ac", "#67a9cf", "#d8be5c", "#ef8a47", "#b2182b"];
const DARK = ["#5aa2e6", "#8fc4e8", "#e3cb6e", "#f39a5c", "#e5576a"];
const R1 = "rgb(33, 102, 172)";
const R1_DARK = "rgb(90, 162, 230)";

const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const stops = (page: Page) => section(page, "Halte der Linie").getByRole("listitem");
const strip = (page: Page) => page.getByRole("list", { name: /^Abschnitte in Richtung/ });
const stripRows = (page: Page) => strip(page).getByRole("listitem");
const direction = (page: Page) => page.getByRole("group", { name: "Fahrtrichtung" });
const U = undefined;
/** The API with its fixtures, except for the line and its sections. */
const withLine = (
  page: Page,
  linie?: Parameters<typeof mockApi>[10],
  abschnitte?: Parameters<typeof mockApi>[11],
) => mockApi(page, U, U, U, U, U, U, U, U, U, linie, abschnitte);
const lineRequests = (requests: URL[]) => requests.filter((u) => u.pathname.startsWith("/linie"));

type Segment = { tip: string; fill: string; alpha: number; dashed: boolean };
/** The segments the map drew, from its test hook, once it is ready. */
async function segments(page: Page): Promise<Segment[]> {
  const map = page.getByTestId("line-map");
  await expect(map).toHaveAttribute("data-ready", "true");
  return JSON.parse((await map.getAttribute("data-segments")) ?? "[]");
}
const segment = (all: Segment[], start: string) => all.find((s) => s.tip.startsWith(start))!;

test("the header shows the label, the type, the way back and the actions", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${LINE_PATH}?von=2026-01&k=median`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "RE57 Dortmund Hbf – Warburg (Westf)",
  );
  await expect(page.getByRole("main").getByText("RE", { exact: true }).first()).toBeVisible();
  const crumb = page.getByRole("navigation", { name: "Brotkrumen" });
  await expect(crumb).toContainText("Rankings › RE57 Dortmund Hbf – Warburg (Westf)");
  await expect(crumb.getByRole("link", { name: "Rankings" })).toHaveAttribute(
    "href",
    "/muster/rankings?von=2026-01&k=median&typ=linien",
  );
  await expect(page.getByRole("button", { name: "Teilen" })).toBeVisible();
  // A line has one train type and is itself the page: no category and no station in the filter bar.
  await expect(page.getByLabel("Gattung:")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Bahnhof/ })).toHaveCount(0);
  await expect(page.getByLabel("Zeitraum von")).toBeVisible();
});

const tiles = (page: Page) =>
  page.getByRole("list", { name: /^(Kennzahlen der ganzen Linie|Key figures of the whole line)$/ });

test("four tiles show the whole line's values, pooled over all stations", async ({ page }) => {
  await mockApi(page);
  await page.goto(LINE_PATH);
  const items = tiles(page).getByRole("listitem");
  await expect(items).toHaveCount(4);
  const expected = [
    ["Pünktlichkeit", "78 %", "n = 27.210"],
    ["Typische Verspätung", "3 min", "n = 27.210"],
    ["Schlechteste 10 %", "12 min", "n = 27.210"],
    ["Ausfälle", "2,0 %", "n = 27.210"],
  ];
  for (const [i, texts] of expected.entries())
    for (const text of texts) await expect(items.nth(i)).toContainText(text);
  // The tiles come first, above the stations.
  const tilesBox = (await tiles(page).boundingBox())!;
  const stopsBox = (await section(page, "Halte der Linie").boundingBox())!;
  expect(tilesBox.y).toBeLessThan(stopsBox.y);
});

test("a line without whole-line values shows empty tiles", async ({ page }) => {
  await withLine(page, () => ({ ...lineFixture(), gesamt: null }));
  await page.goto(LINE_PATH);
  const items = tiles(page).getByRole("listitem");
  await expect(items).toHaveCount(4);
  for (const i of [0, 1, 2, 3]) await expect(items.nth(i)).toContainText("–");
  await expect(stops(page)).toHaveCount(6);
});

test("the no-live-data note appears only for a line without live data", async ({ page }) => {
  const note = /Für diese Linie liefert die Quelle keine Echtzeitdaten/;
  await mockApi(page);
  await page.goto(LINE_PATH);
  await expect(stops(page)).toHaveCount(6);
  await expect(page.getByText(note)).toHaveCount(0);
  await withLine(page, () => ({ ...lineFixture(), ohne_echtzeit: true }));
  await page.goto(LINE_PATH);
  await expect(page.getByText(note)).toContainText("alle Halte gelten als pünktlich.");
  // What the data says is still shown.
  await expect(tiles(page).getByRole("listitem")).toHaveCount(4);
  await expect(stops(page)).toHaveCount(6);
  await expect(strip(page)).toBeVisible();
});

test("a single train says so in its header, and its way back leads to the single trains", async ({
  page,
}) => {
  const hint = "Einzelner Zug, keine Linie: wenige Fahrten je Bahnhof";
  await mockApi(page);
  await page.goto(LINE_PATH);
  await expect(stops(page)).toHaveCount(6);
  await expect(page.getByText(hint)).toHaveCount(0);
  await withLine(page, () => ({ ...lineFixture(), zug: true }));
  await page.goto(`${LINE_PATH}?von=2026-01`);
  await expect(page.getByText(hint)).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Brotkrumen" }).getByRole("link", { name: "Rankings" }),
  ).toHaveAttribute("href", "/muster/rankings?von=2026-01&typ=linien&art=zuege");
});

test("the request names the line and the months, and foreign keys are dropped", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto(
    `${LINE_PATH}?g=fern&bhf=8000207&tag=2026-09-15&land=nw&linie=x&z=monat&von=2026-01`,
  );
  await expect(stops(page)).toHaveCount(6);
  await expect(page).toHaveURL(new RegExp(`${LINE_PATH}\\?von=2026-01$`));
  const [line, sections] = ["/linie", "/linie/abschnitte"].map((path) =>
    queryOf(requests.find((u) => u.pathname === path)),
  );
  expect(line).toEqual({ linie: LINE_ID, von: "2026-01" });
  expect(sections).toEqual({ linie: LINE_ID, von: "2026-01" });
});

test("the stations come in axis order, then the others under their own heading", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(LINE_PATH);
  const rows = stops(page);
  await expect(rows).toHaveCount(6);
  const names = ["Dortmund Hbf", "Hamm (Westf) Hbf", "Soest", "Warburg (Westf)", "Werl"];
  for (const [i, name] of names.entries()) await expect(rows.nth(i)).toContainText(name);
  await expect(rows.nth(5)).toContainText("Haltepunkt ohne Karte");
  await expect(
    section(page, "Halte der Linie").getByRole("heading", { level: 3, name: "Weitere Halte" }),
  ).toBeVisible();
  const first = rows.first();
  for (const text of ["90 %", "n = 9.000", "✕ 2,0 %"]) await expect(first).toContainText(text);
  await expect(first.locator("i").first()).toHaveCSS("background-color", R1);
  // Too few stops: no value, never a colour.
  await expect(rows.nth(2)).toContainText("–");
  await expect(rows.nth(2)).toContainText("n = 10");
});

const AXIS = ["Dortmund Hbf", "Hamm (Westf) Hbf", "Soest", "Warburg (Westf)"];
const axisList = (page: Page) =>
  section(page, "Halte der Linie").getByRole("list", { name: "Entlang der Linie" });
const otherList = (page: Page) =>
  section(page, "Halte der Linie").getByRole("list", { name: "Weitere Halte" });
const widthOf = async (l: Locator) => (await l.boundingBox())!.width;

test("the stations are a route: a dot each, larger ends, a line between, the others apart", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(LINE_PATH);
  const rows = stops(page);
  await expect(rows).toHaveCount(6);
  const dots = axisList(page).getByTestId("stop-dot");
  await expect(dots).toHaveCount(4);
  const [first, second, third, last] = await Promise.all(
    [0, 1, 2, 3].map((i) => widthOf(dots.nth(i))),
  );
  expect(first).toBeGreaterThan(second);
  expect(last).toBeGreaterThan(third);
  expect(second).toBe(third);
  // a line piece on each side of a dot that has a neighbour: 3 gaps, 6 pieces
  await expect(axisList(page).getByTestId("route-line")).toHaveCount(6);
  // every dot sits beside its own row, left of it
  for (const i of [0, 1, 2, 3]) {
    const dot = (await dots.nth(i).boundingBox())!;
    const row = (await rows.nth(i).boundingBox())!;
    expect(dot.y + dot.height / 2).toBeGreaterThan(row.y);
    expect(dot.y + dot.height / 2).toBeLessThan(row.y + row.height);
    expect(dot.x + dot.width).toBeLessThanOrEqual(row.x + 1);
  }
  // the other stops: no line, no dots, below the route under their own heading
  await expect(otherList(page).getByTestId("stop-dot")).toHaveCount(0);
  await expect(otherList(page).getByTestId("route-line")).toHaveCount(0);
  const heading = section(page, "Halte der Linie").getByRole("heading", {
    level: 3,
    name: "Weitere Halte",
  });
  const lastRow = (await rows.nth(3).boundingBox())!;
  expect((await heading.boundingBox())!.y).toBeGreaterThan(lastRow.y + lastRow.height - 1);
});

test("one toggle in the page header turns the station plan and the strip together", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(LINE_PATH);
  await expect(stripRows(page)).toHaveCount(3);
  // above the tiles and not in the Zeitfresser card any more
  await expect(
    section(page, "Zeitfresser").getByRole("group", { name: "Fahrtrichtung" }),
  ).toHaveCount(0);
  expect((await direction(page).boundingBox())!.y).toBeLessThan(
    (await tiles(page).boundingBox())!.y,
  );
  const rows = stops(page);
  for (const [i, name] of AXIS.entries()) await expect(rows.nth(i)).toContainText(name);
  // the larger dots are at the start and the end of the shown direction
  const dots = axisList(page).getByTestId("stop-dot");
  const big = async () => (await widthOf(dots.first())) > (await widthOf(dots.nth(1)));
  expect(await big()).toBe(true);

  await direction(page).getByRole("button", { name: "Richtung Dortmund Hbf" }).click();
  await expect(page).toHaveURL(/[?&]richtung=2/);
  for (const [i, name] of [...AXIS].reverse().entries())
    await expect(rows.nth(i)).toContainText(name);
  await expect(stripRows(page).first()).toContainText("Warburg (Westf) → Soest");
  expect(await big()).toBe(true);
  // the stops off the axis keep their place
  await expect(rows.nth(4)).toContainText("Werl");
  await expect(rows.nth(5)).toContainText("Haltepunkt ohne Karte");

  await direction(page).getByRole("button", { name: "Richtung Warburg (Westf)" }).click();
  await expect(rows.first()).toContainText("Dortmund Hbf");
  await expect(stripRows(page).first()).toContainText("Dortmund Hbf → Hamm (Westf) Hbf");
});

test("a station row links to its page and keeps the metric and the period", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${LINE_PATH}?von=2026-01&k=median`);
  const link = stops(page).first().getByRole("link");
  await expect(link).toHaveAttribute("href", "/bahnhof/08000080?von=2026-01&k=median");
  await link.click();
  await expect(page).toHaveURL(/\/bahnhof\/08000080\?von=2026-01&k=median$/);
});

test("the metric switch changes the station values without a new request", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto(LINE_PATH);
  await expect(stops(page)).toHaveCount(6);
  await expect(strip(page)).toBeVisible();
  const before = lineRequests(requests).length;
  await page.getByRole("button", { name: "Typische Verspätung" }).click();
  await expect(page).toHaveURL(/[?&]k=median$/);
  await expect(stops(page).nth(1)).toContainText("3 min");
  await expect(stops(page).nth(3)).toContainText("9 min");
  // The sections are minutes along the line: the metric does not touch them.
  await expect(stripRows(page).first()).toContainText("−0,8 min");
  expect(lineRequests(requests)).toHaveLength(before);
});

test("the strip lists the sections in travel order with sign, trips and the sum", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(LINE_PATH);
  await expect(
    direction(page).getByRole("button", { name: "Richtung Warburg (Westf)" }),
  ).toHaveAttribute("aria-pressed", "true");
  const rows = stripRows(page);
  await expect(rows).toHaveCount(3);
  const expected = [
    ["Dortmund Hbf → Hamm (Westf) Hbf", "−0,8 min", "12.345 Fahrten"],
    ["Hamm (Westf) Hbf → Soest", "+0,1 min", "8.000 Fahrten"],
    ["Soest → Warburg (Westf)", "+1,8 min", "6.000 Fahrten"],
  ];
  for (const [i, texts] of expected.entries())
    for (const text of texts) await expect(rows.nth(i)).toContainText(text);
  await expect(section(page, "Zeitfresser")).toContainText("Summe der Abschnitte: +1,1 min");
  await expect(section(page, "Zeitfresser")).toContainText("Mittlere Minuten");
  await expect(section(page, "Zeitfresser")).toContainText("Jeder Abschnitt zählt alle Fahrten");
});

test("the direction toggle writes richtung and reverses the strip and the sum", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(`${LINE_PATH}?k=p90`);
  await direction(page).getByRole("button", { name: "Richtung Dortmund Hbf" }).click();
  await expect(page).toHaveURL(/[?&]richtung=2/);
  await expect(page).toHaveURL(/[?&]k=p90/);
  const rows = stripRows(page);
  await expect(rows.first()).toContainText("Warburg (Westf) → Soest");
  await expect(rows.first()).toContainText("+0,6 min");
  await expect(rows.nth(2)).toContainText("Hamm (Westf) Hbf → Dortmund Hbf");
  await expect(rows.nth(2)).toContainText("+0,4 min");
  await expect(section(page, "Zeitfresser")).toContainText("Summe der Abschnitte: +0,7 min");
  // A change of the metric or the period keeps the direction.
  await page.getByRole("button", { name: "Ausfälle", exact: true }).click();
  await expect(page).toHaveURL(/[?&]richtung=2/);
  await direction(page).getByRole("button", { name: "Richtung Warburg (Westf)" }).click();
  await expect(page).not.toHaveURL(/richtung/);
});

test("a richtung key that is the default or invalid is dropped", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${LINE_PATH}?richtung=1`);
  await expect(stripRows(page)).toHaveCount(3);
  await expect(page).not.toHaveURL(/richtung/);
  await page.goto(`${LINE_PATH}?richtung=x&k=p90`);
  await expect(stripRows(page)).toHaveCount(3);
  await expect(page).toHaveURL(/\/linie\/RE57%3A08000080\?k=p90$/);
  await page.goto(`${LINE_PATH}?richtung=2`);
  await expect(stripRows(page).first()).toContainText("Warburg (Westf) → Soest");
  await expect(page).toHaveURL(/richtung=2$/);
});

test("a ring that returns to its first station keeps the closing section in the strip", async ({
  page,
}) => {
  const [dortmund, hamm, soest] = lineFixture().bahnhoefe;
  const ring = () => ({
    ...lineFixture(),
    achse: [dortmund.eva, hamm.eva, soest.eva, dortmund.eva],
    bahnhoefe: [dortmund, hamm, soest],
  });
  const s = (von_eva: string, nach_eva: string, minuten: number) => ({
    von_eva,
    nach_eva,
    minuten,
    n: 1000,
  });
  const sections = () => [
    s(dortmund.eva, hamm.eva, 0.5),
    s(hamm.eva, soest.eva, 0.5),
    s(soest.eva, dortmund.eva, 0.5),
    s(dortmund.eva, soest.eva, 0.1),
    s(soest.eva, hamm.eva, 0.1),
    s(hamm.eva, dortmund.eva, 0.1),
  ];
  await withLine(page, ring, sections);
  await page.goto(LINE_PATH);
  const rows = stripRows(page);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText("Soest → Dortmund Hbf");
  await expect(section(page, "Zeitfresser")).toContainText("Summe der Abschnitte: +1,5 min");
  // The route visits Dortmund at both ends: the station stands at each of its places.
  await expect(stops(page)).toHaveCount(4);
  await expect(stops(page).first()).toContainText("Dortmund Hbf");
  await expect(stops(page).last()).toContainText("Dortmund Hbf");
  await expect(axisList(page).getByTestId("stop-dot")).toHaveCount(4);
  // Both ends are the first station: the toggle names it twice, the first button is pressed.
  const buttons = direction(page).getByRole("button", { name: "Richtung Dortmund Hbf" });
  await expect(buttons).toHaveCount(2);
  await expect(buttons.first()).toHaveAttribute("aria-pressed", "true");
  // Nothing sits in the group of other sections: every section is on the axis.
  await expect(page.getByText(/Äste und Abschnitte mit ausgelassenen Halten/)).toHaveCount(0);
});

test("a line that runs one way shows no toggle and the direction that has data", async ({
  page,
}) => {
  const all = abschnitteFixture();
  const against = new Set(["08000718>08000367", "08000367>08000149", "08000149>08000080"]);
  await withLine(page, U, () => all.filter((s) => against.has(`${s.von_eva}>${s.nach_eva}`)));
  await page.goto(LINE_PATH);
  await expect(strip(page)).toBeVisible();
  await expect(direction(page)).toHaveCount(0);
  await expect(stripRows(page).first()).toContainText("Warburg (Westf) → Soest");
  await expect(strip(page)).toHaveAccessibleName("Abschnitte in Richtung Dortmund Hbf");
  await expect(section(page, "Zeitfresser")).toContainText("Summe der Abschnitte: +0,7 min");
  // The station plan follows the direction that has data.
  await expect(stops(page).first()).toContainText("Warburg (Westf)");
  await expect(stops(page).nth(3)).toContainText("Dortmund Hbf");

  const there = new Set(["08000080>08000149", "08000149>08000367", "08000367>08000718"]);
  await withLine(page, U, () => all.filter((s) => there.has(`${s.von_eva}>${s.nach_eva}`)));
  await page.goto(`${LINE_PATH}?richtung=2`);
  await expect(direction(page)).toHaveCount(0);
  await expect(stripRows(page).first()).toContainText("Dortmund Hbf → Hamm (Westf) Hbf");
  await expect(stops(page).first()).toContainText("Dortmund Hbf");
});

test("a section without trips reads as a dash and adds nothing to the sum", async ({ page }) => {
  await withLine(page, U, () =>
    abschnitteFixture().filter((s) => s.von_eva !== "08000149" || s.nach_eva !== "08000367"),
  );
  await page.goto(LINE_PATH);
  const rows = stripRows(page);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("Hamm (Westf) Hbf → Soest");
  await expect(rows.nth(1)).toContainText("keine Werte");
  await expect(section(page, "Zeitfresser")).toContainText("Summe der Abschnitte: +1,0 min");
  await expect(rows.nth(1).getByTestId("section-bar")).toHaveCount(0);
});

test("branches and skipped stops sit in a closed group with their direction written out", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(LINE_PATH);
  await expect(stripRows(page)).toHaveCount(3);
  const summary = page.getByText("Äste und Abschnitte mit ausgelassenen Halten (4)");
  await expect(summary).toBeVisible();
  const other = page.getByRole("list", { name: "Äste und Abschnitte mit ausgelassenen Halten" });
  await expect(other).toBeHidden();
  await summary.click();
  await expect(other.getByRole("listitem")).toHaveCount(4);
  await expect(other).toContainText("Hamm (Westf) Hbf → Werl");
  await expect(other).toContainText("Werl → Soest");
  await expect(other).toContainText("Dortmund Hbf → Soest");
  await expect(other).toContainText("Soest → Haltepunkt ohne Karte");
  await expect(other).toContainText("+0,3 min");
});

test("each class draws in its token colour, the thin section pale, branches dashed", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(LINE_PATH);
  const one = await segments(page);
  // Six segments: three axis sections of the direction and three that are dashed. The one to the
  // station without coordinates is left out.
  expect(one).toHaveLength(6);
  const solid = one.filter((s) => !s.dashed);
  expect(solid.map((s) => s.fill)).toEqual([LIGHT[0], LIGHT[2], LIGHT[4]]);
  expect(solid.every((s) => s.alpha === 1)).toBe(true);
  expect(segment(one, "Dortmund Hbf → Hamm").tip).toBe(
    "Dortmund Hbf → Hamm (Westf) Hbf: −0,8 min · 12.345 Fahrten",
  );
  const dashed = one.filter((s) => s.dashed);
  expect(dashed.map((s) => s.fill)).toEqual([LIGHT[3], LIGHT[3], LIGHT[2]]);
  expect(dashed.some((s) => s.tip.includes("Haltepunkt"))).toBe(false);

  await direction(page).getByRole("button", { name: "Richtung Dortmund Hbf" }).click();
  await expect(page).toHaveURL(/richtung=2/);
  await expect
    .poll(async () => (await segments(page)).filter((s) => !s.dashed).map((s) => s.fill))
    .toEqual([LIGHT[3], LIGHT[1], LIGHT[3]]);
  const two = await segments(page);
  expect(two).toHaveLength(6);
  const thin = segment(two, "Hamm (Westf) Hbf → Dortmund Hbf");
  expect(thin.alpha).toBe(0.5);
  expect(thin.tip).toBe("Hamm (Westf) Hbf → Dortmund Hbf: +0,4 min · 30 Fahrten");
  expect(segment(two, "Warburg (Westf) → Soest").alpha).toBe(1);
});

test("the strip bars carry the class colour and the thin one is pale", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${LINE_PATH}?richtung=2`);
  const bars = stripRows(page).getByTestId("section-bar");
  await expect(bars).toHaveCount(3);
  const colours = await bars.evaluateAll((all) =>
    all.map((b) => {
      const style = getComputedStyle(b);
      return [style.backgroundColor, style.opacity];
    }),
  );
  expect(colours).toEqual([
    ["rgb(239, 138, 71)", "1"],
    ["rgb(103, 169, 207)", "1"],
    ["rgb(239, 138, 71)", "0.5"],
  ]);
});

test("the legend names the five steps and the pale marker", async ({ page }) => {
  await mockApi(page);
  await page.goto(LINE_PATH);
  const legend = page.getByRole("list", { name: "Farbstufen der Abschnitte" });
  await expect(legend.getByRole("listitem")).toHaveText([
    "unter −0,5 min",
    "−0,5 bis −0,15 min",
    "−0,15 bis +0,15 min",
    "+0,15 bis +1 min",
    "über +1 min",
  ]);
  await expect(section(page, "Zeitfresser")).toContainText("blass: weniger als 50 Fahrten");
});

test("the map is ready, labelled, tall enough and inside the page width", async ({ page }) => {
  await mockApi(page);
  await page.goto(LINE_PATH);
  const map = page.getByTestId("line-map");
  await expect(map).toHaveAttribute("data-ready", "true");
  const box = (await map.boundingBox())!;
  expect(box.height).toBeGreaterThan(250);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.getByRole("region", { name: "Karte der Zeitfresser" })).toBeVisible();
});

test("the sparkline links to the time series of the line", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto(`${LINE_PATH}?k=p90`);
  const card = section(page, "Letzte 12 Monate");
  await expect(card.getByTestId("point")).toHaveCount(12);
  const link = card.getByRole("link", { name: "Zeitverlauf →" });
  await expect(link).toHaveAttribute("href", "/muster/zeitverlauf?linie=RE57%3A08000080&k=p90");
  expect(queryOf(requests.find((u) => u.pathname === "/zeitverlauf"))).toEqual({
    linie: LINE_ID,
    gattung: "alle",
  });
  await link.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Zeitverlauf");
});

test("the time series of a line links back to its page", async ({ page }) => {
  await mockApi(page);
  await page.goto("/muster/zeitverlauf?linie=RE57%3A08000080&k=p90&von=2026-01");
  const link = page.getByRole("link", { name: "Linienseite" });
  await expect(link).toHaveAttribute("href", "/linie/RE57%3A08000080?von=2026-01&k=p90");
  await link.click();
  await expect(page).toHaveURL(/\/linie\/RE57%3A08000080\?von=2026-01&k=p90$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("RE57");
  // A station's series has no line page to go to.
  await page.goto("/muster/zeitverlauf?bhf=8000207");
  await expect(page.getByRole("link", { name: "Linienseite" })).toHaveCount(0);
});

test("a line with no sections says so and keeps the stations", async ({ page }) => {
  await withLine(page, U, () => []);
  await page.goto(LINE_PATH);
  await expect(stops(page)).toHaveCount(6);
  await expect(section(page, "Zeitfresser")).toContainText(
    "Für diese Linie liegen im Zeitraum keine Abschnittswerte vor.",
  );
  await expect(strip(page)).toHaveCount(0);
});

test("an unknown line is a state with the way back to the rankings", async ({ page }) => {
  const requests = await withLine(
    page,
    () => NOT_FOUND,
    () => NOT_FOUND,
  );
  await page.goto("/linie/Gibt-es-nicht");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Diese Linie kennen wir nicht");
  const back = page.getByRole("link", { name: "Zu den Rankings" });
  await expect(back).toHaveAttribute("href", "/muster/rankings?typ=linien");
  expect(queryOf(requests.find((u) => u.pathname === "/linie"))).toEqual({
    linie: "Gibt-es-nicht",
  });
  await back.click();
  await expect(page).toHaveURL(/\/muster\/rankings\?typ=linien$/);
});

test("a failed request shows the error and a retry loads the line", async ({ page }) => {
  let calls = 0;
  await withLine(page, () => (calls++ === 0 ? null : lineFixture()));
  await page.goto(LINE_PATH);
  await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(stops(page)).toHaveCount(6);
});

test("the sidebar has no Verspätungsketten item any more", async ({ page, isMobile }) => {
  test.skip(isMobile, "the sidebar is desktop only");
  await mockApi(page);
  await page.goto(LINE_PATH);
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByText("Gespeicherte Fahrten")).toBeVisible();
  await expect(nav.getByText("Verspätungsketten")).toHaveCount(0);
});

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  test("bars and map segments use the dark step colours", async ({ page }) => {
    await mockApi(page);
    await page.goto(LINE_PATH);
    await expect(stops(page).first().locator("i").first()).toHaveCSS("background-color", R1_DARK);
    const all = await segments(page);
    expect(all.filter((s) => !s.dashed).map((s) => s.fill)).toEqual([DARK[0], DARK[2], DARK[4]]);
  });

  test("the route dots and line take the dark tokens", async ({ page }) => {
    await mockApi(page);
    await page.goto(LINE_PATH);
    const dots = axisList(page).getByTestId("stop-dot");
    await expect(dots).toHaveCount(4);
    // --text-2 for the ends, --text-3 for the others and the line (dark set)
    await expect(dots.first()).toHaveCSS("border-top-color", "rgb(166, 175, 189)");
    await expect(dots.nth(1)).toHaveCSS("border-top-color", "rgb(131, 139, 153)");
    await expect(axisList(page).getByTestId("route-line").first()).toHaveCSS(
      "background-color",
      "rgb(131, 139, 153)",
    );
  });
});

test.describe("English", () => {
  test.use({ locale: "en-US" });

  test("the page reads in English with decimal points", async ({ page }) => {
    await mockApi(page);
    await page.goto(LINE_PATH);
    await expect(section(page, "Stops of the line")).toBeVisible();
    await expect(section(page, "Time wasters")).toContainText("Sum of the sections: +1.1 min");
    const toggle = page.getByRole("group", { name: "Direction of travel" });
    await expect(toggle.getByRole("button", { name: "Direction Warburg (Westf)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page
        .getByRole("list", { name: /^Sections in direction/ })
        .getByRole("listitem")
        .first(),
    ).toContainText("12,345 trips");
  });

  test("the tiles, the no-live-data note and the single-train hint read in English", async ({
    page,
  }) => {
    await withLine(page, () => ({ ...lineFixture(), zug: true, ohne_echtzeit: true }));
    await page.goto(LINE_PATH);
    const items = tiles(page).getByRole("listitem");
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText("Punctuality");
    await expect(items.nth(0)).toContainText("78%");
    await expect(items.nth(1)).toContainText("Typical delay");
    await expect(items.nth(3)).toContainText("Cancellations");
    await expect(items.nth(3)).toContainText("2.0%");
    await expect(
      page.getByText("The source has no live data for this line: every stop counts as on time."),
    ).toBeVisible();
    await expect(page.getByText("A single train, not a line: few runs per station")).toBeVisible();
  });
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("one column, no sideways scroll, the strip rows are cards", async ({ page }) => {
    await mockApi(page);
    await page.goto(LINE_PATH);
    await expect(stops(page)).toHaveCount(6);
    await expect(stripRows(page)).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const row = stops(page).first();
    const name = (await row.getByText("Dortmund Hbf").boundingBox())!;
    const bar = (await row.locator("i").first().boundingBox())!;
    expect(bar.y).toBeGreaterThan(name.y + name.height - 1);
  });

  test("the route fits the phone in both directions, with the dots left of the rows", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(`${LINE_PATH}?richtung=2`);
    await expect(stripRows(page)).toHaveCount(3);
    await expect(stops(page).first()).toContainText("Warburg (Westf)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const dot = (await axisList(page).getByTestId("stop-dot").first().boundingBox())!;
    const row = (await stops(page).first().boundingBox())!;
    expect(dot.x).toBeGreaterThanOrEqual(0);
    expect(dot.x + dot.width).toBeLessThanOrEqual(row.x + 1);
  });

  test("the direction toggle and the metric switch have a hit area of at least 44 px", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(LINE_PATH);
    await expect(stripRows(page)).toHaveCount(3);
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
      direction(page).getByRole("button", { name: "Richtung Warburg (Westf)" }),
      direction(page).getByRole("button", { name: "Richtung Dortmund Hbf" }),
      page.getByRole("button", { name: "Ausfälle", exact: true }),
      page.getByRole("navigation", { name: "Brotkrumen" }).getByRole("link", { name: "Rankings" }),
      page.getByText("Äste und Abschnitte mit ausgelassenen Halten (4)"),
    ];
    for (const c of controls) expect(await tall(c), `${await c.textContent()}`).toBe(true);
  });
});

test.describe("Bildfahrplan", () => {
  const bf = (page: Page) => section(page, "Bildfahrplan");
  const chart = (page: Page) => page.getByTestId("bildfahrplan");
  const trips = (page: Page) => chart(page).locator("[data-trip]");
  const trip = (page: Page, zug: string) => chart(page).locator(`[data-trip="${zug}"]`);
  const ist = (page: Page, zug: string) => trip(page, zug).locator('[data-path="ist"] line');
  /** Hovers the first actual segment of a trip; a scroll clears the tooltip, so it comes first. */
  const hoverTrip = async (page: Page, zug: string) => {
    await fontsReady(page);
    await chart(page).scrollIntoViewIfNeeded();
    await ist(page, zug).first().hover();
  };
  const dayField = (page: Page) => page.getByLabel("Tag des Bildfahrplans");
  const asked = (requests: URL[]) =>
    requests.filter((u) => u.pathname === "/linie/fahrplan").map((u) => queryOf(u));
  const strokes = (l: Locator) =>
    l.evaluateAll((all) => all.map((e) => getComputedStyle(e).stroke));
  const rgb = (hex: string) =>
    `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  const withFahrplan = (
    page: Page,
    linie?: Parameters<typeof mockApi>[10],
    fahrplan?: Parameters<typeof mockApi>[12],
  ) => mockApi(page, U, U, U, U, U, U, U, U, U, linie, U, fahrplan);
  /** The fixture's day with only the trips that `keep` names. */
  const only = (keep: (zug: string) => boolean) => (id: string, tag: string) => {
    const day = fahrplanFixture(id, tag);
    return { ...day, fahrten: day.fahrten.filter((f) => keep(f.zug)) };
  };

  test("it follows the Zeitfresser, asks for the newest day and holds the day field to the window", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto(LINE_PATH);
    await expect(trips(page)).toHaveCount(3);
    await expect(chart(page)).toHaveAttribute("data-trips", "3");
    expect(asked(requests)).toEqual([{ linie: LINE_ID, tag: FAHRPLAN_BIS }]);
    await expect(dayField(page)).toHaveValue(FAHRPLAN_BIS);
    await expect(dayField(page)).toHaveAttribute("min", FAHRPLAN_VON);
    await expect(dayField(page)).toHaveAttribute("max", FAHRPLAN_BIS);
    await expect(page).not.toHaveURL(/tag=/);
    await expect(bf(page)).toContainText("Gestrichelt der Fahrplan");
    await expect(chart(page)).toHaveAccessibleName(
      "Bildfahrplan RE57 Dortmund Hbf – Warburg (Westf), Mi., 30.09.2026: 3 Fahrten",
    );
    expect((await bf(page).boundingBox())!.y).toBeGreaterThan(
      (await section(page, "Zeitfresser").boundingBox())!.y,
    );
  });

  test("picking a day writes tag and asks for that day; the newest day is not written", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto(`${LINE_PATH}?k=p90`);
    await expect(trips(page)).toHaveCount(3);
    await dayField(page).fill("2026-09-20");
    await expect(page).toHaveURL(/\?tag=2026-09-20&k=p90$/);
    await expect.poll(() => asked(requests).at(-1)).toEqual({ linie: LINE_ID, tag: "2026-09-20" });
    await expect(chart(page)).toHaveAccessibleName(/So\., 20\.09\.2026/);
    await dayField(page).fill(FAHRPLAN_BIS);
    await expect(page).toHaveURL(new RegExp(`${LINE_PATH}\\?k=p90$`));
  });

  test("a tag inside the window is kept; the newest day, one outside or an invalid one is dropped", async ({
    page,
  }) => {
    const requests = await mockApi(page);
    await page.goto(`${LINE_PATH}?tag=2026-09-20`);
    await expect(trips(page)).toHaveCount(3);
    await expect(dayField(page)).toHaveValue("2026-09-20");
    await expect(page).toHaveURL(/\?tag=2026-09-20$/);
    expect(asked(requests).at(-1)).toEqual({ linie: LINE_ID, tag: "2026-09-20" });
    for (const tag of [FAHRPLAN_BIS, "2026-09-16", "2026-10-01", "2026-02-31"]) {
      await page.goto(`${LINE_PATH}?tag=${tag}&k=p90`);
      await expect(page).toHaveURL(new RegExp(`${LINE_PATH}\\?k=p90$`));
      await expect(dayField(page)).toHaveValue(FAHRPLAN_BIS);
    }
    // No request ever names a day outside the window.
    expect(asked(requests).every((q) => q.tag >= FAHRPLAN_VON && q.tag <= FAHRPLAN_BIS)).toBe(true);
  });

  test("each trip has a dashed planned path and an actual path; branch trips are counted, not drawn", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(LINE_PATH);
    await expect(trips(page)).toHaveCount(3);
    expect(
      await trips(page).evaluateAll((all) => all.map((g) => g.getAttribute("data-trip"))),
    ).toEqual(["RE 10101", "RE 10102", "RE 10199"]);
    for (const zug of ["RE 10101", "RE 10102", "RE 10199"]) {
      await expect(trip(page, zug).locator('[data-path="plan"]')).toHaveCount(1);
      await expect(trip(page, zug).locator('[data-path="ist"]')).toHaveCount(1);
    }
    const plan = trip(page, "RE 10101").locator('[data-path="plan"]');
    await expect(plan).toHaveAttribute("stroke-dasharray", /\d/);
    await expect(plan).toHaveCSS("stroke", "rgb(101, 109, 126)");
    await expect(bf(page)).toContainText("1 Fahrt auf einem Ast nicht gezeigt");

    await withFahrplan(page, U, (id, tag) => {
      const day = fahrplanFixture(id, tag);
      return { ...day, fahrten: [...day.fahrten, { ...day.fahrten[2], zug: "RE 10151" }] };
    });
    await page.goto(LINE_PATH);
    await expect(trips(page)).toHaveCount(3);
    await expect(bf(page)).toContainText("2 Fahrten auf Ästen nicht gezeigt");
  });

  test("the actual path takes the delay step at each segment's end and breaks at a cancelled stop", async ({
    page,
  }) => {
    const R = LIGHT.map(rgb);
    await mockApi(page);
    await page.goto(LINE_PATH);
    await expect(trips(page)).toHaveCount(3);
    // +1, +1, +3, +3, +8 min; then +2, +2, +5 min
    expect(await strokes(ist(page, "RE 10101"))).toEqual([R[1], R[1], R[2], R[2], R[4]]);
    expect(await strokes(ist(page, "RE 10199"))).toEqual([R[2], R[2], R[3]]);
    // Warburg to Soest and the stop at Soest; nothing into or out of the cancelled Hamm.
    expect(await strokes(ist(page, "RE 10102"))).toEqual([R[0], R[0]]);
    await expect(chart(page).getByTestId("cancel")).toHaveCount(1);
    const cancel = trip(page, "RE 10102").getByTestId("cancel");
    await expect(cancel).toHaveText("✕");
    await expect(cancel).toHaveCSS("fill", "rgb(93, 102, 117)");
    const legend = bf(page).getByRole("list", { name: "Farbstufen der Verspätung" });
    await expect(legend.getByRole("listitem")).toHaveText([
      "<1 min",
      "1–2",
      "2–4",
      "4–7",
      "≥7 min",
    ]);
    await expect(bf(page)).toContainText("Fahrplan");
    await expect(bf(page)).toContainText("fällt aus");
  });

  test("the time axis runs past midnight for a night trip and opens at 06:00", async ({ page }) => {
    await mockApi(page);
    await page.goto(LINE_PATH);
    const hours = chart(page).getByTestId("hour");
    await expect(hours).toHaveCount(26);
    await expect(hours.first()).toHaveText("00:00");
    await expect(hours.last()).toHaveText("01:00");
    const six = hours.nth(6);
    await expect(six).toHaveText("06:00");
    const scroller = chart(page).locator("xpath=..");
    expect(await scroller.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    const box = (await scroller.boundingBox())!;
    const at = (await six.boundingBox())!;
    expect(at.x).toBeGreaterThanOrEqual(box.x);
    expect(at.x + at.width).toBeLessThan(box.x + 60);
    // Without the night trip the axis ends at 24:00.
    await withFahrplan(
      page,
      U,
      only((zug) => zug !== "RE 10199"),
    );
    await page.goto(LINE_PATH);
    await expect(trips(page)).toHaveCount(2);
    await expect(hours).toHaveCount(25);
  });

  test("hovering a trip highlights it and names its stops with planned time and delay", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(LINE_PATH);
    await expect(trips(page)).toHaveCount(3);
    const tip = page.getByRole("tooltip");
    await hoverTrip(page, "RE 10101");
    await expect(tip).toHaveText(
      "RE 10101: Dortmund Hbf 06:00 ±0 min · Hamm (Westf) Hbf 06:20 +1 min · Soest 06:40 +3 min · Warburg (Westf) 07:30 +8 min",
    );
    await expect(trip(page, "RE 10102")).toHaveCSS("opacity", "0.25");
    await expect(trip(page, "RE 10101")).toHaveCSS("opacity", "1");
    await hoverTrip(page, "RE 10102");
    await expect(tip).toContainText("RE 10102: Warburg (Westf) 07:00 ±0 min");
    await expect(tip).toContainText("Hamm (Westf) Hbf 08:00 fällt aus");
    await expect(trip(page, "RE 10101")).toHaveCSS("opacity", "0.25");
  });

  test("the trips are listed in a closed group as the chart's text", async ({ page }) => {
    await mockApi(page);
    await page.goto(LINE_PATH);
    const summary = bf(page).getByText("Fahrten als Liste (3)");
    await expect(summary).toBeVisible();
    const table = bf(page).getByRole("table");
    await expect(table).toBeHidden();
    await summary.click();
    const rows = table.getByRole("row");
    await expect(rows).toHaveCount(4);
    await expect(rows.first().getByRole("columnheader")).toHaveText([
      "Zug",
      "Von",
      "Bis",
      "Abfahrt (Plan)",
      "Verspätung am Ende",
    ]);
    const expected = [
      ["RE 10101", "Dortmund Hbf", "Warburg (Westf)", "06:00", "+8 min"],
      ["RE 10102", "Warburg (Westf)", "Dortmund Hbf", "07:00", "±0 min"],
      ["RE 10199", "Dortmund Hbf", "Soest", "23:40", "+5 min"],
    ];
    for (const [i, cells] of expected.entries())
      await expect(rows.nth(i + 1).getByRole("cell")).toHaveText(cells);
  });

  test("a ring trip takes each visit of its repeated station nearest its neighbours", async ({
    page,
  }) => {
    const [dortmund, hamm, soest] = lineFixture().bahnhoefe;
    const [D, H, S] = [dortmund.eva, hamm.eva, soest.eva];
    const halt = (eva: string, an: number | null, ab: number | null) => ({
      eva,
      an_plan: an,
      an_ist: an,
      ab_plan: ab,
      ab_ist: ab,
      ausfall_an: false,
      ausfall_ab: false,
    });
    await withFahrplan(
      page,
      () => ({ ...lineFixture(), achse: [D, H, S, D], bahnhoefe: [dortmund, hamm, soest] }),
      (_id, tag) => ({
        tag,
        fahrten: [
          {
            zug: "S 1",
            halte: [halt(D, null, 360), halt(H, 380, 381), halt(S, 400, 401), halt(D, 430, null)],
          },
          {
            zug: "S 2",
            halte: [halt(D, null, 500), halt(S, 520, 521), halt(H, 540, 541), halt(D, 560, null)],
          },
        ],
      }),
    );
    await page.goto(LINE_PATH);
    await expect(trips(page)).toHaveCount(2);
    const ys = async (zug: string) =>
      ((await trip(page, zug).locator('[data-path="plan"]').getAttribute("points")) ?? "")
        .trim()
        .split(/\s+/)
        .map((p) => Number(p.split(",")[1]));
    // S 1 runs down from the first Dortmund to the last, S 2 up from the last to the first.
    const one = await ys("S 1");
    expect(one).toEqual([...one].sort((a, b) => a - b));
    expect(one.at(-1)).toBeGreaterThan(one[0]);
    const two = await ys("S 2");
    expect(two).toEqual([...two].sort((a, b) => b - a));
    expect(two[0]).toBe(one.at(-1));
    expect(two.at(-1)).toBe(one[0]);
  });

  test("a ring trip that does not start at the seam draws no segment across the chart", async ({
    page,
  }) => {
    const [D, H, S, W] = lineFixture().bahnhoefe.map((s) => s.eva);
    const halt = (eva: string, an: number | null, ab: number | null) => ({
      eva,
      an_plan: an,
      an_ist: an,
      ab_plan: ab,
      ab_ist: ab,
      ausfall_an: false,
      ausfall_ab: false,
    });
    await withFahrplan(
      page,
      () => ({ ...lineFixture(), achse: [D, H, S, W, D] }),
      (_id, tag) => ({
        tag,
        fahrten: [
          {
            zug: "S 3",
            halte: [
              halt(S, null, 400),
              halt(W, 450, 451),
              halt(D, 520, 521),
              halt(H, 540, 541),
              halt(S, 560, null),
            ],
          },
        ],
      }),
    );
    await page.goto(LINE_PATH);
    await expect(trips(page)).toHaveCount(1);
    const height = Number(await chart(page).getAttribute("height"));
    // Every step of every polyline (planned and the hover line) and every actual segment.
    const steps = await trip(page, "S 3").evaluate((g) => [
      ...Array.from(g.querySelectorAll("polyline")).flatMap((p) => {
        const ys = (p.getAttribute("points") ?? "")
          .trim()
          .split(/\s+/)
          .map((pt) => Number(pt.split(",")[1]));
        return ys.slice(1).map((y, k) => Math.abs(y - ys[k]));
      }),
      ...Array.from(g.querySelectorAll('[data-path="ist"] line')).map((l) =>
        Math.abs(Number(l.getAttribute("y2")) - Number(l.getAttribute("y1"))),
      ),
    ]);
    expect(steps.length).toBeGreaterThan(0);
    expect(Math.max(...steps)).toBeLessThan(height / 2);
    // Both pieces are drawn: Soest to the closing Dortmund, and Hamm on to Soest.
    await expect(trip(page, "S 3").locator('[data-path="plan"]')).toHaveCount(2);
  });

  test("without a trip window the card says so, asks nothing and drops the tag", async ({
    page,
  }) => {
    const requests = await withFahrplan(page, () => ({
      ...lineFixture(),
      fahrplan_von: null,
      fahrplan_bis: null,
    }));
    await page.goto(`${LINE_PATH}?tag=2026-09-20`);
    await expect(bf(page)).toContainText("Für den Bildfahrplan liegen keine Fahrten vor.");
    await expect(page).not.toHaveURL(/tag=/);
    await expect(dayField(page)).toHaveCount(0);
    await expect(chart(page)).toHaveCount(0);
    expect(asked(requests)).toEqual([]);
  });

  test("a day without trips says so and keeps the day field", async ({ page }) => {
    await withFahrplan(
      page,
      U,
      only(() => false),
    );
    await page.goto(LINE_PATH);
    await expect(bf(page)).toContainText("Für diesen Tag liegen keine Fahrten der Linie vor.");
    await expect(chart(page)).toHaveCount(0);
    await expect(dayField(page)).toHaveValue(FAHRPLAN_BIS);
  });

  test("a failed day shows the error in the card and a retry draws it", async ({ page }) => {
    let calls = 0;
    await withFahrplan(page, U, (id, tag) => (calls++ === 0 ? null : fahrplanFixture(id, tag)));
    await page.goto(LINE_PATH);
    await expect(bf(page).getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
    await expect(stops(page)).toHaveCount(6);
    await bf(page).getByRole("button", { name: "Erneut versuchen" }).click();
    await expect(trips(page)).toHaveCount(3);
  });

  test.describe("dark theme", () => {
    test.use({ colorScheme: "dark" });

    test("the paths, the steps and the cancelled mark take the dark tokens", async ({ page }) => {
      await mockApi(page);
      await page.goto(LINE_PATH);
      await expect(trips(page)).toHaveCount(3);
      const R = DARK.map(rgb);
      expect(await strokes(ist(page, "RE 10101"))).toEqual([R[1], R[1], R[2], R[2], R[4]]);
      await expect(trip(page, "RE 10101").locator('[data-path="plan"]')).toHaveCSS(
        "stroke",
        "rgb(131, 139, 153)",
      );
      await expect(chart(page).getByTestId("cancel")).toHaveCSS("fill", "rgb(138, 147, 163)");
    });
  });

  test.describe("English", () => {
    test.use({ locale: "en-US" });

    test("the Bildfahrplan reads in English", async ({ page }) => {
      await mockApi(page);
      await page.goto(LINE_PATH);
      const card = section(page, "Graphic timetable");
      await expect(card).toContainText("1 trip on a branch not shown");
      await expect(card.getByText("Trips as a list (3)")).toBeVisible();
      await expect(page.getByLabel("Day of the graphic timetable")).toHaveValue(FAHRPLAN_BIS);
      await expect(chart(page)).toHaveAccessibleName(/^Graphic timetable RE57 .*: 3 trips$/);
      await hoverTrip(page, "RE 10102");
      await expect(page.getByRole("tooltip")).toContainText("Hamm (Westf) Hbf 08:00 cancelled");
    });
  });

  test.describe("mobile", () => {
    test.skip(({ isMobile }) => !isMobile, "mobile layout");

    test("the plot scrolls inside its card, the station names stay, and a tap shows the trip", async ({
      page,
    }) => {
      await mockApi(page);
      await page.goto(LINE_PATH);
      await expect(trips(page)).toHaveCount(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const scroller = chart(page).locator("xpath=..");
      expect(await scroller.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
      const name = bf(page).getByTestId("bf-stations").getByText("Warburg (Westf)");
      await name.scrollIntoViewIfNeeded();
      const before = (await name.boundingBox())!;
      await scroller.evaluate((e) => (e.scrollLeft = e.scrollWidth));
      const after = (await name.boundingBox())!;
      expect(after.x).toBe(before.x);
      expect(after.x).toBeGreaterThanOrEqual(0);
      expect(after.x + after.width).toBeLessThanOrEqual((await scroller.boundingBox())!.x + 1);

      // Back to 06:00, and the scroll's event done before the tap (a scroll clears the tooltip).
      await scroller.evaluate((e) => (e.scrollLeft = 360));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const tip = page.getByRole("tooltip");
      await ist(page, "RE 10101").first().tap();
      await expect(tip).toContainText("RE 10101");
      await page.getByRole("heading", { level: 1 }).tap();
      await expect(tip).toHaveCount(0);
    });

    test("the day field has a hit area of at least 44 px", async ({ page }) => {
      await mockApi(page);
      await page.goto(LINE_PATH);
      await expect(trips(page)).toHaveCount(3);
      const tall = await dayField(page).evaluate((el) => {
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = el.closest("label")!;
        return [-21, 21].every((dy) => hit.contains(document.elementFromPoint(x, y + dy)));
      });
      expect(tall).toBe(true);
    });
  });
});
