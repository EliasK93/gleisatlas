import { expect, test, type Page } from "@playwright/test";
import { formatPeriod, localLabel } from "../src/metrics";
import { EMPTY_KARTE, fontsReady, karteFixture, linienFixture, mockApi, queryOf } from "./fixtures";

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
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Karte");
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
      "Daten: Deutsche Bahn (via piebro/deutsche-bahn-data und DB Timetables API), CC BY 4.0, aggregiert",
    ),
  ).toBeAttached();
  const dataset = attribution.getByRole("link", {
    name: "piebro/deutsche-bahn-data",
    includeHidden: true,
  });
  await expect(dataset).toHaveAttribute(
    "href",
    "https://huggingface.co/datasets/piebro/deutsche-bahn-data",
  );
  // The compact control may be collapsed, which hides its links; they stay in the DOM.
  const licence = attribution.getByRole("link", { name: "CC BY 4.0", includeHidden: true });
  await expect(licence).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0/deed.de",
  );
  await expect(licence).toHaveAttribute("target", "_blank");
});

test("leaving the map while its card resizes throws no page error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockApi(page);
  for (const width of [200, 300, 400]) {
    await page.goto("/karte");
    await expect(page.getByTestId("map-card")).toBeVisible();
    // The card resizes and the route changes in the same task, so the observer's callback runs
    // once the map page is gone.
    await page.evaluate((w) => {
      document.querySelector<HTMLElement>("[data-testid=map-card]")!.style.width = `${w}px`;
      history.pushState(null, "", "/muster/heatmap");
      dispatchEvent(new PopStateEvent("popstate"));
    }, width);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wochentag × Uhrzeit");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
  }
  expect(errors).toEqual([]);
});

test("a tab that becomes visible again sends no second /karte request", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/karte");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  const karte = () => requests.filter((u) => u.pathname === "/karte").length;
  expect(karte()).toBe(1);
  // As the browser sends it: at the document, bubbling up to the window.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
  );
  // A refetch would go out at once; a second is plenty of time to see it.
  await page.waitForTimeout(1000);
  expect(karte()).toBe(1);
});

test("?bhf= opens the panel; Schließen removes bhf and keeps the rest", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?g=fern&bhf=8000207");
  const p = panel(page);
  await expect(p.getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
  await expect(p).toContainText("EVA 8000207 · Fernverkehr");
  await expect(p).toContainText(
    "6 von 10 Ankünften sind pünktlich. Die schlechtesten 10 % kommen mindestens 21 min zu spät.",
  );
  for (const v of ["67 %", "3 min", "21 min", "4,3 %"]) await expect(p).toContainText(v);
  await expect(p).toContainText("n = 33.744 Halte · 1.–30. Sept. 2026");
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
    page.getByText(
      "Median: Die Hälfte der Ankünfte ist weniger verspätet, die andere Hälfte mehr.",
    ),
  ).toBeAttached();
  // The legend names the metric and leaves the explanation to the switch.
  await expect(legend(page).getByText("Median:")).toHaveCount(0);
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

/** Holds back /karte (not the page of the same path) until `release` is called. */
async function holdKarte(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  // Registered after the mock, so it sees the request first and then hands it on.
  await page.route(
    (url) => url.pathname === "/karte",
    async (route) => {
      if (route.request().isNavigationRequest()) return route.fallback();
      await gate;
      await route.fallback();
    },
  );
  return release;
}
const loading = (page: Page) => page.getByRole("status").filter({ hasText: "Lade Bahnhöfe" });

test("a card over the map says the stations load, and goes with the data", async ({ page }) => {
  await mockApi(page);
  const release = await holdKarte(page);
  await page.goto("/karte");
  await expect(loading(page)).toBeVisible();
  await expect(page.getByText(/Der Server startet gerade/)).toHaveCount(0);
  release();
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await expect(loading(page)).toHaveCount(0);
});

test("after 5 seconds the loading card adds that the server is starting, with the seconds", async ({
  page,
}) => {
  await mockApi(page);
  await holdKarte(page);
  await page.clock.install();
  await page.goto("/karte");
  await expect(loading(page)).toBeVisible();
  const hint = page.getByText(/Der Server startet gerade \(\d+ s\)/);
  await page.clock.fastForward(4000);
  await expect(hint).toHaveCount(0);
  await page.clock.fastForward(1500);
  await expect(hint).toContainText(/\([56] s\), das kann bis zu einer Minute dauern\./);
  await page.clock.fastForward(3000);
  await expect(hint).toContainText(/\((8|9|10) s\)/);
});

test("a failed /karte shows the error instead of the loading card", async ({ page }) => {
  await mockApi(page, undefined, () => null);
  await page.goto("/karte");
  await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await expect(loading(page)).toHaveCount(0);
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
      "1.–30. Sept. 2026 · Alle Gattungen · Bahnhöfe auf der Karte: 4 · ohne Koordinaten: 10",
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

  const card = (page: Page) => page.getByTestId("map-card");

  /**
   * Where the initial view puts Köln and the north edge of Germany (Web Mercator): the map fits
   * Germany with 24 px padding, except on top, where the filter card plus a 12 px gap stays free.
   */
  async function startView(page: Page) {
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    await fontsReady(page);
    const mercator = (lon: number, lat: number) => ({
      x: (lon + 180) / 360,
      y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI),
    });
    const sw = mercator(5.9, 47.3);
    const ne = mercator(15.0, 55.05);
    const box = (await map(page).boundingBox())!;
    const cardBox = (await card(page).boundingBox())!;
    const top = cardBox.y + cardBox.height + 12 - box.y;
    const scale = Math.min(
      (box.width - 48) / (ne.x - sw.x),
      (box.height - top - 24) / (sw.y - ne.y),
    );
    const centre = { x: (sw.x + ne.x) / 2, y: (sw.y + ne.y) / 2 };
    const project = (lon: number, lat: number) => {
      const p = mercator(lon, lat);
      return {
        x: box.x + box.width / 2 + (p.x - centre.x) * scale,
        y: box.y + top + (box.height - top - 24) / 2 + (p.y - centre.y) * scale,
      };
    };
    return {
      koeln: project(6.959, 50.943),
      north: project(10, 55.05).y,
      cardBottom: cardBox.y + cardBox.height,
    };
  }

  for (const [width, height] of [
    [1024, 768],
    [1280, 800],
    [1440, 900],
    [1600, 1200],
  ])
    test(`the start view fits Germany below the filter card at ${width}×${height}`, async ({
      page,
    }) => {
      await mockApi(page);
      await page.setViewportSize({ width, height });
      await page.goto("/karte");
      const { koeln, north, cardBottom } = await startView(page);
      expect(north).toBeGreaterThanOrEqual(cardBottom);
      // The model is right when the dot is where it says: a click there selects Köln.
      await page.mouse.click(koeln.x, koeln.y);
      await expect(page).toHaveURL(/\/karte\?bhf=8000207$/);
    });

  for (const width of [1024, 1280, 1440])
    test(`the open panel and the filter card stay apart at ${width} px`, async ({ page }) => {
      await mockApi(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/karte?bhf=8000207");
      await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
      await fontsReady(page);
      const c = (await card(page).boundingBox())!;
      const p = (await panel(page).boundingBox())!;
      expect(c.x + c.width, "card ends before the panel").toBeLessThanOrEqual(p.x);
      for (const el of await card(page).locator("button, select").all()) {
        const b = (await el.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(c.x);
        expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width);
        expect(b.y + b.height).toBeLessThanOrEqual(c.y + c.height);
      }
    });

  test("clicking the selected station again adds no history entry", async ({ page }) => {
    await mockApi(page);
    await page.goto("/karte");
    const at = (await startView(page)).koeln;
    await page.mouse.click(at.x, at.y);
    await expect(page).toHaveURL(/\/karte\?bhf=8000207$/);
    await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
    const before = await page.evaluate(() => history.length);
    await page.mouse.click(at.x, at.y);
    await page.mouse.click(at.x, at.y);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test("a click on the map keeps the camera, though the card grows with the panel", async ({
    page,
  }) => {
    // At 1440 × 900 the narrower card wraps "Zurücksetzen" into a row of its own.
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await page.goto("/karte");
    const at = (await startView(page)).koeln;
    const before = (await card(page).boundingBox())!.height;
    await page.mouse.click(at.x, at.y);
    await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
    await expect.poll(async () => (await card(page).boundingBox())!.height).toBeGreaterThan(before);
    // Köln is still under the pointer: hovering the same spot names it again.
    await page.mouse.move(at.x + 200, at.y + 200);
    await page.mouse.move(at.x, at.y);
    await expect(page.getByText(/^Köln Hbf · /)).toBeVisible();
  });

  test("the panel sits at the right, 360 px wide", async ({ page }) => {
    await mockApi(page);
    await page.goto("/karte?bhf=8000207");
    const box = (await panel(page).boundingBox())!;
    expect(box.width).toBe(360);
    expect(box.x + box.width).toBeGreaterThan((page.viewportSize()!.width ?? 0) - 20);
  });
});

test.describe("mobile", { tag: "@phone" }, () => {
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

test("the attribution sits below the zoom buttons", { tag: "@phone" }, async ({ page }) => {
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

test.describe("the lines in the station panel", () => {
  const U = undefined;
  /** The API lists the worst first; the fixture is turned around so only the sort puts the busiest on top. */
  const open = async (page: Page, query: string) => {
    const requests = await mockApi(page, U, U, U, U, () => linienFixture().reverse());
    await page.goto(`/karte?bhf=8000207&${query}`);
    return requests;
  };
  const lines = (page: Page) => panel(page).getByRole("region", { name: "Häufigste Linien" });

  test("list the five busiest lines with type, name and the value in the metric", async ({
    page,
  }) => {
    await open(page, "von=2026-08&bis=2026-09");
    const rows = lines(page).getByRole("listitem");
    await expect(rows).toHaveCount(5);
    const expected = ["50 %", "53 %", "56 %", "59 %", "62 %"];
    for (const [i, value] of expected.entries()) {
      await expect(rows.nth(i)).toContainText(`RE ${i + 1} · Köln Hbf`);
      await expect(rows.nth(i)).toContainText(value);
      await expect(rows.nth(i).getByText("RE", { exact: true })).toBeVisible();
    }
    // The map's metric decides the value.
    await page.getByRole("button", { name: "Schlechteste 10 %" }).click();
    for (const i of [0, 1, 2, 3, 4]) await expect(rows.nth(i)).toContainText("8 min");
  });

  test("a row opens the line page with the metric and the period", async ({ page }) => {
    await open(page, "von=2026-08&bis=2026-09&k=median");
    const first = lines(page).getByRole("link").first();
    await expect(first).toHaveAttribute(
      "href",
      "/linie/RE%201%3A8000207?von=2026-08&bis=2026-09&k=median",
    );
    await first.click();
    await expect(page).toHaveURL(/\/linie\/RE%201%3A8000207\?von=2026-08&bis=2026-09&k=median$/);
  });

  test("ask for the station's lines in the map's category and months", async ({ page }) => {
    const requests = await open(page, "g=fern&von=2026-08&bis=2026-09");
    await expect(lines(page).getByRole("listitem")).toHaveCount(5);
    const asked = requests.filter((u) => u.pathname === "/stationen/8000207/linien");
    expect(asked.map(queryOf)).toEqual([{ gattung: "fern", von: "2026-08", bis: "2026-09" }]);
  });

  test("Alle 12 Linien opens the station page at its lines", async ({ page }) => {
    await open(page, "g=fern");
    const all = panel(page).getByRole("link", { name: "Alle 12 Linien" });
    await expect(all).toHaveAttribute("href", "/bahnhof/8000207?g=fern&bhf=8000207#linien");
    await all.click();
    await expect(page).toHaveURL(/\/bahnhof\/8000207\?g=fern#linien$/);
    const card = page.getByRole("region", { name: "Linien an diesem Bahnhof" });
    await expect(card).toBeInViewport();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  });

  test("a second station never shows the first station's lines while its own load", async ({
    page,
  }) => {
    await mockApi(page);
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    await page.route("**/stationen/8000105/linien*", async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto("/karte?bhf=8000207");
    await expect(lines(page).getByRole("listitem")).toHaveCount(5);
    await page.evaluate(() => {
      history.pushState(null, "", "/karte?bhf=8000105");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Frankfurt (Main) Hbf");
    await expect(lines(page).getByRole("status")).toBeVisible();
    await expect(lines(page).getByRole("listitem")).toHaveCount(0);
    release();
    await expect(lines(page).getByRole("listitem")).toHaveCount(5);
  });

  test("a station with up to five lines has no link to all", async ({ page }) => {
    await mockApi(page, U, U, U, U, () => linienFixture().slice(0, 3));
    await page.goto("/karte?bhf=8000207");
    await expect(lines(page).getByRole("listitem")).toHaveCount(3);
    await expect(lines(page).getByRole("link", { name: /^Alle \d+ Linien$/ })).toHaveCount(0);
  });

  test("a station without lines says so, and a failed request offers a retry", async ({ page }) => {
    await mockApi(page, U, U, U, U, () => []);
    await page.goto("/karte?bhf=8000207");
    await expect(lines(page)).toContainText("Mit diesen Filtern gibt es hier keine Linien.");
    await mockApi(page, U, U, U, U, () => null);
    await page.goto("/karte?bhf=8000207");
    await expect(panel(page).getByRole("alert")).toBeVisible();
  });

  test("the months the lines cover stand on one line of their own below the heading, days rounded outward", async ({
    page,
  }) => {
    const months = (period: string) => lines(page).getByText(period, { exact: true });
    await open(page, "von=2026-08-10&bis=2026-09-25");
    await expect(months(formatPeriod("2026-08", "2026-09"))).toBeVisible();
    await open(page, "von=2026-09-03&bis=2026-09-25");
    await expect(months(formatPeriod("2026-09"))).toBeVisible();
    // Without a period in the URL: the covered range, from full coverage to the newest month.
    await open(page, "k=median");
    const longest = months(formatPeriod("2025-11", "2026-09"));
    await expect(longest).toBeVisible();
    await expect(lines(page).getByRole("heading")).toHaveText("Häufigste Linien");
    const [heading, period] = [
      (await lines(page).getByRole("heading").boundingBox())!,
      (await longest.boundingBox())!,
    ];
    expect(period.y).toBeGreaterThanOrEqual(heading.y + heading.height);
    expect(period.height).toBeLessThan(24);
  });

  test(
    "on a phone the actions stay in the sheet without scrolling, above the lines",
    { tag: "@phone" },
    async ({ page, isMobile }) => {
      test.skip(!isMobile, "mobile layout");
      await open(page, "g=fern");
      await expect(lines(page).getByRole("listitem")).toHaveCount(5);
      const sheet = (await panel(page).boundingBox())!;
      const details = (await panel(page)
        .getByRole("link", { name: "Alle Details" })
        .boundingBox())!;
      expect(details.y).toBeGreaterThanOrEqual(sheet.y);
      expect(details.y + details.height).toBeLessThanOrEqual(sheet.y + sheet.height);
      expect(await panel(page).evaluate((el) => el.scrollTop)).toBe(0);
      const first = (await lines(page).getByRole("link").first().boundingBox())!;
      expect(first.y).toBeGreaterThan(details.y + details.height);
    },
  );

  test("a row on a phone is at least 44 px high", { tag: "@phone" }, async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile layout");
    await open(page, "g=fern");
    const rows = lines(page).getByRole("link");
    await expect(rows).toHaveCount(6);
    for (const i of [0, 1, 2, 3, 4, 5]) {
      await rows.nth(i).scrollIntoViewIfNeeded();
      expect((await rows.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
