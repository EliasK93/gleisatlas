import { expect, test, type Page } from "@playwright/test";
import { localLabel } from "../src/metrics";
import { EMPTY_KARTE, karteFixture, mockApi } from "./fixtures";

const map = (page: Page) => page.getByTestId("map");
const panel = (page: Page) => page.getByRole("complementary");
const legend = (page: Page) => page.getByRole("region", { name: "Legende" });

test("base map labels use German names, other text fields stay", () => {
  // The label expression of the OpenFreeMap positron style, which prefers English names.
  const english = [
    "case",
    ["has", "name:nonlatin"],
    ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]],
    ["coalesce", ["get", "name_en"], ["get", "name"]],
  ];
  expect(localLabel(english)).toEqual(["coalesce", ["get", "name:de"], ["get", "name"]]);
  const shield = ["to-string", ["get", "ref"]];
  expect(localLabel(shield)).toBe(shield);
});

test("/ and unknown paths land on the map with the query kept", async ({ page }) => {
  await mockApi(page);
  await page.goto("/?g=fern");
  await expect(page).toHaveURL(/\/karte\?g=fern$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wie zuverlässig ist die Bahn?");
  await page.goto("/gibt-es-nicht?k=p90");
  await expect(page).toHaveURL(/\/karte\?k=p90$/);
});

test("the map renders the stations and has no footer", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  // MapLibre's CSS must not collapse the container.
  expect((await map(page).boundingBox())!.height).toBeGreaterThan(300);
  // The focusable map canvas carries the accessible name.
  await expect(page.getByRole("region", { name: "Deutschlandkarte mit Bahnhöfen" })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toHaveCount(0);
  const attribution = page.locator(".maplibregl-ctrl-attrib");
  await expect(
    attribution.getByText(
      "Daten: Deutsche Bahn via piebro/deutsche-bahn-data, CC BY 4.0, aggregiert",
    ),
  ).toBeAttached();
  // The compact control may be collapsed, which hides its links; they stay in the DOM.
  const licence = attribution.getByRole("link", { name: "CC BY 4.0", includeHidden: true });
  await expect(licence).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0/deed.de",
  );
  await expect(licence).toHaveAttribute("target", "_blank");
});

test("?bhf= opens the panel; Schließen removes bhf and keeps the rest", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?g=fern&bhf=8000207");
  const p = panel(page);
  await expect(p.getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
  await expect(p).toContainText("EVA 8000207 · Fernverkehr");
  await expect(p).toContainText(
    "6 von 10 Ankünften sind pünktlich. An schlechten Tagen kommen Züge bis zu 21 min später.",
  );
  for (const v of ["67 %", "3 min", "21 min", "4,3 %"]) await expect(p).toContainText(v);
  await expect(p).toContainText("n = 33.744 Halte · Sept. 2026");
  await expect(p.getByRole("link", { name: "Alle Details" })).toHaveAttribute(
    "href",
    "/bahnhof/8000207?g=fern&bhf=8000207",
  );
  await expect(p.getByRole("link", { name: /Verbindung ab hier/ })).toHaveCount(0);
  await expect(p.getByRole("alert")).toHaveCount(0);
  await p.getByRole("button", { name: "Schließen" }).click();
  await expect(page).toHaveURL(/\/karte\?g=fern$/);
  await expect(panel(page)).toHaveCount(0);
});

test("the panel closes with Escape", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?bhf=8000207");
  await panel(page).getByRole("button", { name: "Schließen" }).focus();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/karte$/);
});

test("little data gets a note in the panel", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?bhf=8000999");
  await expect(panel(page)).toContainText("Wenig Daten (n = 9) – Werte schwanken stark");
});

test("a station without map data shows its name and a hint", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?bhf=08002549");
  const p = panel(page);
  await expect(p.getByRole("heading", { level: 2 })).toHaveText("Hamburg Hbf");
  await expect(p).toContainText("Für diesen Bahnhof gibt es mit diesen Filtern keine Kartendaten.");
  await expect(p.getByRole("link", { name: "Alle Details" })).toBeVisible();
});

test("the Bahnhof chip selects a station", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte");
  await page.getByRole("button", { name: /^Bahnhof/ }).click();
  await page.getByRole("combobox", { name: "Bahnhof suchen" }).fill("köln");
  await page.getByRole("option", { name: /Köln Hbf/ }).click();
  await expect(page).toHaveURL(/[?&]bhf=8000207/);
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
});

test("the metric switch writes k without refetching", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/karte");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  const before = requests.filter((u) => u.pathname === "/karte").length;
  await page.getByRole("button", { name: "Typische Verspätung" }).click();
  await expect(page).toHaveURL(/[?&]k=median/);
  await expect(page.getByRole("button", { name: "Typische Verspätung" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByText("Median: die Hälfte der Fahrten ist weniger verspätet"),
  ).toBeAttached();
  expect(requests.filter((u) => u.pathname === "/karte").length).toBe(before);
});

test("Gattung refetches with gattung", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/karte");
  await page.getByLabel("Gattung").selectOption("fern");
  await expect(page).toHaveURL(/[?&]g=fern/);
  await expect
    .poll(() =>
      requests.some((u) => u.pathname === "/karte" && u.searchParams.get("gattung") === "fern"),
    )
    .toBe(true);
});

test("keys written in any order keep the same map, loaded once", async ({ page }) => {
  const styles: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("https://tiles.openfreemap.org/styles/")) styles.push(r.url());
  });
  await mockApi(page);
  await page.goto("/karte");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await map(page).evaluate((el) => (el.dataset.mark = "kept"));
  // k first, then bhf, then g: each write adds a key in front of the ones already there.
  await page.getByRole("button", { name: "Typische Verspätung" }).click();
  await page.getByRole("button", { name: /^Bahnhof/ }).click();
  await page.getByRole("combobox", { name: "Bahnhof suchen" }).fill("köln");
  await page.getByRole("option", { name: /Köln Hbf/ }).click();
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
  await page.getByLabel("Gattung").selectOption("fern");
  await expect(page).toHaveURL(/\/karte\?g=fern&bhf=8000207&k=median$/);
  await expect(map(page)).toHaveAttribute("data-mark", "kept");
  expect(styles).toHaveLength(1);
});

test("closing the panel returns the focus to the map", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?bhf=8000207");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await panel(page).getByRole("button", { name: "Schließen" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(map(page).locator("canvas")).toBeFocused();
});

test("/karte/ with a trailing slash is the full-bleed map too", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte/?g=fern");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await expect(page.getByRole("contentinfo")).toHaveCount(0);
  expect((await map(page).boundingBox())!.height).toBeGreaterThan(300);
});

test("a station that comes with the map data needs no lookup", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/karte?bhf=8000207");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  expect(requests.some((u) => u.pathname === "/stationen/8000207")).toBe(false);
});

test("a share of 96 % reads 9 von 10, never 10", async ({ page }) => {
  const karte = karteFixture();
  karte.stationen[0].puenktlich = 0.96;
  await mockApi(page, undefined, () => karte);
  await page.goto("/karte?bhf=8000207");
  await expect(panel(page)).toContainText("9 von 10 Ankünften sind pünktlich");
});

test("empty state offers a reset", async ({ page }) => {
  await mockApi(page, undefined, () => EMPTY_KARTE);
  await page.goto("/karte?g=fern");
  await expect(page.getByText("Keine Bahnhöfe für diese Filter")).toBeVisible();
  await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
  await expect(page).toHaveURL(/\/karte$/);
});

test("error state keeps the filters and recovers on retry", async ({ page }) => {
  let calls = 0;
  await mockApi(page, undefined, () => (calls++ === 0 ? null : karteFixture()));
  await page.goto("/karte?g=fern");
  await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]g=fern/);
});

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("legend shows scale, keys and how many stations are drawn", async ({ page }) => {
    await mockApi(page);
    await page.goto("/karte");
    const l = legend(page);
    for (const text of [
      "Pünktlichkeit",
      "≥90 %",
      "<60 %",
      "zuverlässig",
      "unzuverlässig",
      "sehr wenig Daten (n < 15)",
      "wenig Daten (n < 50)",
      "Größe = Anzahl Halte",
      "Sept. 2026 · Alle Gattungen · Bahnhöfe auf der Karte: 4 · ohne Koordinaten: 10",
    ])
      await expect(l).toContainText(text);
  });

  test.describe("English", () => {
    test.use({ locale: "en-US" });

    test("legend names the two little-data keys", async ({ page }) => {
      await mockApi(page);
      await page.goto("/karte");
      const l = page.getByRole("region", { name: "Legend" });
      await expect(l).toContainText("very little data (n < 15)");
      await expect(l).toContainText("little data (n < 50)");
    });
  });

  test("clicking the selected station again adds no history entry", async ({ page }) => {
    await mockApi(page);
    await page.goto("/karte");
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    // The initial view fits Germany with 24 px padding; project Köln into it (Web Mercator).
    const mercator = (lon: number, lat: number) => ({
      x: (lon + 180) / 360,
      y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI),
    });
    const sw = mercator(5.9, 47.3);
    const ne = mercator(15.0, 55.05);
    const box = (await map(page).boundingBox())!;
    const scale = Math.min((box.width - 48) / (ne.x - sw.x), (box.height - 48) / (sw.y - ne.y));
    const koeln = mercator(6.959, 50.943);
    const at = {
      x: box.x + box.width / 2 + (koeln.x - (sw.x + ne.x) / 2) * scale,
      y: box.y + box.height / 2 + (koeln.y - (sw.y + ne.y) / 2) * scale,
    };
    await page.mouse.click(at.x, at.y);
    await expect(page).toHaveURL(/\/karte\?bhf=8000207$/);
    await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
    const before = await page.evaluate(() => history.length);
    await page.mouse.click(at.x, at.y);
    await page.mouse.click(at.x, at.y);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test("the panel sits at the right, 360 px wide", async ({ page }) => {
    await mockApi(page);
    await page.goto("/karte?bhf=8000207");
    const box = (await panel(page).boundingBox())!;
    expect(box.width).toBe(360);
    expect(box.x + box.width).toBeGreaterThan((page.viewportSize()!.width ?? 0) - 20);
  });
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("the zoom buttons and the attribution toggle have 44 px tap areas", async ({ page }) => {
    await mockApi(page);
    await page.goto("/karte");
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    const controls = [
      page.getByRole("button", { name: "Vergrößern" }),
      page.getByRole("button", { name: "Verkleinern" }),
      // MapLibre makes the attribution toggle a <summary>, which has no button role.
      page.locator("summary.maplibregl-ctrl-attrib-button"),
    ];
    for (const c of controls) {
      // A tap 21 px above and below the centre still lands on the control.
      const ok = await c.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return [-21, 21].every((dy) => el.contains(document.elementFromPoint(x, y + dy)));
      });
      expect(ok, `${await c.getAttribute("aria-label")}`).toBe(true);
    }
  });

  test("panel is a bottom sheet above the tab bar, legend collapsed, no sideways scroll", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/karte?bhf=8000207");
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    const sheet = (await panel(page).boundingBox())!;
    const tabs = (await page.getByRole("navigation", { name: "Hauptnavigation" }).boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(sheet.width).toBe(width);
    expect(Math.abs(sheet.y + sheet.height - tabs.y)).toBeLessThanOrEqual(1);
    // The sheet covers the legend; close it first.
    await panel(page).getByRole("button", { name: "Schließen" }).click();
    const toggle = page.getByRole("button", { name: "Legende" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Größe = Anzahl Halte")).toBeHidden();
    await toggle.click();
    await expect(page.getByText("Größe = Anzahl Halte")).toBeVisible();
    const scroll = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth <= innerWidth,
      y: document.documentElement.scrollHeight <= innerHeight,
    }));
    expect(scroll).toEqual({ x: true, y: true });
  });
});

test("the attribution sits below the zoom buttons", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  const zoom = (await page.getByRole("button", { name: "Verkleinern" }).boundingBox())!;
  const attribution = (await page.locator(".maplibregl-ctrl-attrib").boundingBox())!;
  expect(attribution.y).toBeGreaterThanOrEqual(zoom.y + zoom.height);
});

test("the open attribution wraps instead of running under the legend", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "the phone map is too narrow for the open attribution");
  await mockApi(page);
  for (const width of [1024, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/karte");
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    const open = page.locator(".maplibregl-ctrl-attrib.maplibregl-compact-show");
    await expect(open, `${width}`).toBeVisible();
    const a = (await open.boundingBox())!;
    const l = (await legend(page).boundingBox())!;
    const apart = a.x >= l.x + l.width || a.y >= l.y + l.height || a.y + a.height <= l.y;
    expect(apart, `${width}`).toBe(true);
  }
});
