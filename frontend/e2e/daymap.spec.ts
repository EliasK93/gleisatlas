import { expect, test, type Page } from "@playwright/test";
import { fontsReady, mockApi, tageskarteFixture } from "./fixtures";

const CORS = { "access-control-allow-origin": "*" };

const DAY = "2026-09-15";
const map = (page: Page) => page.getByTestId("map");
const panel = (page: Page) => page.getByRole("complementary");
const legend = (page: Page) => page.getByRole("region", { name: "Legende" });
const germany = (page: Page) => page.getByRole("region", { name: "Deutschland an diesem Tag" });
const mode = (page: Page) => page.getByRole("group", { name: "Zeitraum oder Tag" });
const dayRequests = (requests: URL[]) => requests.filter((u) => u.pathname === "/tageskarte");

/** The day map on `tag`, with the map drawn. */
async function open(page: Page, query = `tag=${DAY}`) {
  const requests = await mockApi(page);
  await page.goto(`/karte?${query}`);
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  return requests;
}

/** Opens the collapsed legend of a phone; on desktop it is always open. */
async function openLegend(page: Page) {
  const toggle = page.getByRole("button", { name: "Legende" });
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
}

const STATIONS = {
  koeln: [6.959, 50.943],
  frankfurt: [8.663, 50.107],
  problemhausen: [12.0, 53.0],
  ueblingen: [9.5, 51.5],
  ohnevergleich: [11.0, 49.0],
  dresden: [13.7, 51.05],
} as const;

/**
 * Where the start view puts a station: it fits Germany into the map, minus the padding set in
 * MapPage (on desktop the filter card's bottom edge plus 12 px on top).
 */
async function locate(page: Page, [lon, lat]: readonly [number, number], isMobile: boolean) {
  const box = (await map(page).boundingBox())!;
  const card = (await page.getByTestId("map-card").boundingBox())!;
  const mercator = (lo: number, la: number) => ({
    x: (lo + 180) / 360,
    y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360)) / (2 * Math.PI),
  });
  const { top, bottom, left, right } = isMobile
    ? { top: 140, bottom: 40, left: 8, right: 8 }
    : { top: card.y + card.height + 12 - box.y, bottom: 24, left: 24, right: 24 };
  const sw = mercator(5.9, 47.3);
  const ne = mercator(15.0, 55.05);
  const w = box.width - left - right;
  const h = box.height - top - bottom;
  const scale = Math.min(w / (ne.x - sw.x), h / (sw.y - ne.y));
  const p = mercator(lon, lat);
  return {
    x: Math.round(box.x + left + w / 2 + (p.x - (sw.x + ne.x) / 2) * scale),
    y: Math.round(box.y + top + h / 2 + (p.y - (sw.y + ne.y) / 2) * scale),
  };
}

/** The colour of the rendered pixel at a station, read from a screenshot with the overlays hidden. */
async function colourAt(page: Page, station: readonly [number, number], isMobile: boolean) {
  const { x, y } = await locate(page, station, isMobile);
  const hide = await page.addStyleTag({
    content: "main > div > :not(:first-child) { visibility: hidden }",
  });
  const png = (await page.screenshot({ scale: "css" })).toString("base64");
  await hide.evaluate((el) => (el as Element).remove());
  return page.evaluate(
    async ([data, px, py]) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${data}`)).blob(),
      );
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const [r, g, b] = ctx.getImageData(Number(px), Number(py), 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    },
    [png, x, y] as const,
  );
}

const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    const hex = getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgb(${r}, ${g}, ${b})`;
  }, name);

test("the Tag switch writes tag, drops von and bis and asks for /tageskarte; Zeitraum drops tag", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/karte?g=fern&von=2026-03&bis=2026-09");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await expect(page.getByLabel("Zeitraum von")).toBeVisible();
  expect(dayRequests(requests)).toHaveLength(0);

  await mode(page).getByRole("button", { name: "Tag", exact: true }).click();
  // The last day of the data, and nothing of the period is left.
  await expect(page).toHaveURL(/\/karte\?g=fern&tag=2026-09-30$/);
  await expect(page.getByLabel("Zeitraum von")).toHaveCount(0);
  await expect(page.getByLabel("Zeitraum bis")).toHaveCount(0);
  await expect(mode(page).getByRole("button", { name: "Tag", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() => dayRequests(requests).map((u) => u.search))
    .toEqual(["?tag=2026-09-30&gattung=fern"]);

  await mode(page).getByRole("button", { name: "Zeitraum", exact: true }).click();
  await expect(page).toHaveURL(/\/karte\?g=fern$/);
  await expect(page.getByLabel("Zeitraum von")).toBeVisible();
  await expect(page.getByLabel("Tag auswählen")).toHaveCount(0);
});

test("the metric switch writes k in day mode without a new request", async ({ page }) => {
  const requests = await open(page);
  await page.getByRole("button", { name: "Typische Verspätung" }).click();
  await expect(page).toHaveURL(new RegExp(`/karte\\?tag=${DAY}&k=median$`));
  expect(dayRequests(requests)).toHaveLength(1);
});

test("the day picker is limited to the days of the data and writes tag", async ({ page }) => {
  const requests = await open(page);
  const picker = page.getByLabel("Tag auswählen");
  await expect(picker).toHaveAttribute("type", "date");
  await expect(picker).toHaveAttribute("min", "2024-07-01");
  await expect(picker).toHaveAttribute("max", "2026-09-30");
  await expect(picker).toHaveValue(DAY);
  await picker.fill("2026-09-10");
  await expect(page).toHaveURL(/\/karte\?tag=2026-09-10$/);
  await expect
    .poll(() => dayRequests(requests).map((u) => u.searchParams.get("tag")))
    .toEqual([DAY, "2026-09-10"]);
});

test("typing a date key by key writes only complete days inside the data", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "a phone's date field is a picker, not typed");
  const requests = await open(page);
  const picker = page.getByLabel("Tag auswählen");
  await picker.focus();
  // Day and month are the same, so the field's segment order does not matter. The year passes
  // through 0002, 0020 and 0202 on the way, which lie before the first day of the data.
  await picker.pressSequentially("09092026");
  await expect(page).toHaveURL(/\/karte\?tag=2026-09-09$/);
  await expect(picker).toHaveValue("2026-09-09");
  await expect
    .poll(() => dayRequests(requests).map((u) => u.searchParams.get("tag")))
    .toEqual([DAY, "2026-09-09"]);
});

test("while the next day loads, the legend, panel and card still name the day they show", async ({
  page,
}) => {
  const NEXT = "2026-09-10";
  // On a phone the open panel covers the legend's toggle; its text is in the page either way.
  await open(page, `tag=${DAY}&bhf=8000207`);
  let asked = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  // Registered after the mock, so it sees the request first and then hands it on.
  await page.route(
    (url) => url.pathname === "/tageskarte" && url.searchParams.get("tag") === NEXT,
    async (route) => {
      asked = true;
      await gate;
      await route.fallback();
    },
  );
  await page.getByLabel("Tag auswählen").fill(NEXT);
  await expect(page).toHaveURL(new RegExp(`tag=${NEXT}`));
  await expect.poll(() => asked).toBe(true);
  await expect(panel(page)).toContainText("n = 3.000 Halte · Di., 15.09.2026");
  await expect(legend(page)).toContainText("12 × Dienstag");
  await expect(legend(page)).toContainText("Di., 15.09.2026 ·");
  await expect(germany(page)).toContainText("Di., 15.09.2026");
  release();
  await expect(panel(page)).toContainText("n = 3.000 Halte · Do., 10.09.2026");
  await expect(legend(page)).toContainText("12 × Donnerstag");
  await expect(legend(page)).toContainText("Do., 10.09.2026 ·");
});

test("a failed /datenstand shows the error banner instead of loading for ever", async ({
  page,
}) => {
  await mockApi(page);
  let calls = 0;
  await page.route(
    (url) => url.pathname === "/datenstand",
    (route) =>
      calls++ === 0 ? route.fulfill({ status: 500, headers: CORS, body: "" }) : route.fallback(),
  );
  await page.goto(`/karte?tag=${DAY}`);
  await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await expect(germany(page)).toContainText("Di., 15.09.2026");
});

test("a day outside the data moves to its edge, an impossible day is dropped", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?tag=2030-01-01");
  await expect(page).toHaveURL(/\/karte\?tag=2026-09-30$/);
  await page.goto("/karte?tag=2020-01-01");
  await expect(page).toHaveURL(/\/karte\?tag=2024-07-01$/);
  await page.goto("/karte?tag=2026-02-31");
  await expect(page).toHaveURL(/\/karte$/);
  await expect(page.getByLabel("Zeitraum von")).toBeVisible();
});

test("a link with von and bis and a tag keeps only the tag", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/karte?von=2026-03&bis=2026-09&tag=${DAY}&k=p90`);
  await expect(page).toHaveURL(new RegExp(`/karte\\?tag=${DAY}&k=p90$`));
});

test("the other pages drop tag", async ({ page }) => {
  await mockApi(page);
  for (const path of [
    "/muster/heatmap",
    "/muster/rankings",
    "/muster/zeitverlauf",
    "/bahnhof/8000207",
  ]) {
    await page.goto(`${path}?g=fern&tag=${DAY}`);
    await expect(page).toHaveURL(new RegExp(`${path}\\?g=fern$`));
  }
});

test.describe("stations are coloured by the class the API gives", () => {
  // The API's field of each metric button; its class is the fill, 1 to 5 on the r scale, none grey.
  const metrics = [
    ["Pünktlichkeit", "puenktlich"],
    ["Typische Verspätung", "median"],
    ["Schlechte Tage (P90)", "p90"],
    ["Ausfälle", "ausfallquote"],
  ] as const;
  const order = [1, 2, 3, 4, 5, null];
  const names = Object.keys(STATIONS) as (keyof typeof STATIONS)[];

  test("every class from 1 to 5 and none has its fill, for each metric", async ({
    page,
    isMobile,
  }) => {
    // Six equal stations; each metric reads the classes shifted by one, so the fill must follow
    // the field of the selected metric.
    const day = (tag: string) => {
      const fixture = tageskarteFixture(tag);
      const base = fixture.stationen[0];
      const cls = (i: number) => order[i % order.length];
      fixture.stationen = names.map((name, i) => ({
        ...base,
        eva: String(8100000 + i),
        name,
        lon: STATIONS[name][0],
        lat: STATIONS[name][1],
        n: 1000,
        klasse: {
          puenktlich: cls(i),
          median: cls(i + 1),
          p90: cls(i + 2),
          ausfallquote: cls(i + 3),
        },
      }));
      return fixture;
    };
    await mockApi(
      page,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      day,
    );
    await page.goto(`/karte?tag=${DAY}`);
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    for (const [shift, [button]] of metrics.entries()) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await expect(map(page)).toHaveAttribute("data-ready", "true");
      for (const [i, name] of names.entries()) {
        const cls = order[(i + shift) % order.length];
        const want = await token(page, cls ? `r${cls}` : "c3");
        await expect
          .poll(() => colourAt(page, STATIONS[name], isMobile), `${button} ${name} ${cls}`)
          .toBe(want);
      }
    }
  });

  test("a day without any normal is grey everywhere", async ({ page, isMobile }) => {
    await open(page, "tag=2026-04-04");
    const grey = await token(page, "c3");
    await expect.poll(() => colourAt(page, STATIONS.koeln, isMobile)).toBe(grey);
    await expect.poll(() => colourAt(page, STATIONS.frankfurt, isMobile)).toBe(grey);
  });
});

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "needs a hover");

  test("the tooltip names the day's value, the normal and the class", async ({ page }) => {
    // Tall enough that the cards of the bottom left do not stand over Köln.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page);
    await fontsReady(page);
    const koeln = await locate(page, STATIONS.koeln, false);
    await page.mouse.move(koeln.x + 150, koeln.y + 150);
    await page.mouse.move(koeln.x, koeln.y);
    await expect(page.getByRole("tooltip")).toHaveText(
      "Köln Hbf · 50 % · üblich 80 % · viel schlechter",
    );
    const none = await locate(page, STATIONS.ohnevergleich, false);
    await page.mouse.move(none.x, none.y);
    await expect(page.getByRole("tooltip")).toHaveText(
      "Ohnevergleich · 70 % · kein Vergleich möglich",
    );
  });

  test("the card sits at the bottom left, above the legend and clear of the open panel", async ({
    page,
  }) => {
    await open(page, `tag=${DAY}&bhf=8000207`);
    await fontsReady(page);
    const card = (await germany(page).boundingBox())!;
    const key = (await legend(page).boundingBox())!;
    const side = (await panel(page).boundingBox())!;
    expect(card.x).toBe(key.x);
    expect(card.width).toBe(key.width);
    expect(card.y + card.height).toBeLessThanOrEqual(key.y);
    expect(card.x + card.width).toBeLessThanOrEqual(side.x);
  });
});

test.describe("the legend", () => {
  test("shows five deviation steps, the grey key, the little-data keys and the reference days", async ({
    page,
  }) => {
    await open(page);
    await openLegend(page);
    const l = legend(page);
    for (const text of [
      "Pünktlichkeit",
      "viel besser",
      "besser",
      "wie üblich",
      "schlechter",
      "viel schlechter",
      "kein Vergleich möglich",
      "sehr wenig Daten (n < 15)",
      "wenig Daten (n < 50)",
      "Größe = Anzahl Halte",
      "Vergleichstage: 12 × Dienstag aus den 12 Wochen davor",
      "„Wie üblich“ heißt: innerhalb der gewohnten Schwankung der Station",
      "Di., 15.09.2026 · Alle Gattungen · Bahnhöfe auf der Karte: 6 · ohne Koordinaten: 2",
    ])
      await expect(l).toContainText(text);
    // The period map's keys are gone.
    await expect(l).not.toContainText("zuverlässig");
  });

  test.describe("English", () => {
    test.use({ locale: "en-US" });

    test("the switch, the steps and the card read English", async ({ page }) => {
      await mockApi(page);
      await page.goto(`/karte?tag=${DAY}`);
      await expect(map(page)).toHaveAttribute("data-ready", "true");
      await expect(
        page
          .getByRole("group", { name: "Period or day" })
          .getByRole("button", { name: "Day", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await openLegend(page);
      const l = page.getByRole("region", { name: "Legend" });
      for (const text of ["much better", "as usual", "much worse", "no comparison possible"])
        await expect(l).toContainText(text);
      await expect(l).toContainText("Reference days: 12 × Tuesday from the 12 weeks before");
      const card = page.getByRole("region", { name: "Germany on this day" });
      await expect(card.getByRole("img")).toHaveAccessibleName(
        "Thunderstorm: much worse than usual",
      );
    });
  });
});

test.describe("the Germany card", () => {
  test("shows the symbol, the day's value and the normal for the metric", async ({ page }) => {
    await open(page);
    const card = germany(page);
    await expect(card.getByRole("img")).toHaveAccessibleName(
      "Gewitter: viel schlechter als üblich",
    );
    await expect(card).toContainText("Di., 15.09.2026 · 78,9 % pünktlich · üblich 83,3 %");
    await expect(card).not.toContainText("Datenlücke");
    await page.getByRole("button", { name: "Typische Verspätung" }).click();
    await expect(card).toContainText("Di., 15.09.2026 · typisch 1 min verspätet · üblich 1 min");
    await expect(card.getByRole("img")).toHaveAccessibleName("Wolkig: wie üblich");
    await page.getByRole("button", { name: "Ausfälle", exact: true }).click();
    await expect(card).toContainText("5,9 % ausgefallen · üblich 4,2 %");
  });

  test("has a symbol for each of the five ranks", async ({ page }) => {
    const labels = [
      "Sonnig: viel besser als üblich",
      "Heiter: besser als üblich",
      "Wolkig: wie üblich",
      "Regen: schlechter als üblich",
      "Gewitter: viel schlechter als üblich",
    ];
    let rank = 1;
    const day = (tag: string) => {
      const fixture = tageskarteFixture(tag);
      fixture.deutschland!.wetter.puenktlich = rank;
      return fixture;
    };
    await mockApi(
      page,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      day,
    );
    for (const [i, label] of labels.entries()) {
      rank = i + 1;
      await page.goto(`/karte?tag=${DAY}`);
      await expect(germany(page).getByRole("img")).toHaveAccessibleName(label);
    }
  });

  test("notes the hours missing from the data and has a neutral symbol that names the gap", async ({
    page,
  }) => {
    await open(page, "tag=2026-03-14");
    await expect(germany(page)).toContainText("Datenlücke: 6 h fehlen");
    await expect(germany(page)).toContainText("Sa., 14.03.2026");
    await expect(germany(page).getByRole("img")).toHaveAccessibleName(
      "Kein Vergleich möglich: Datenlücke an diesem Tag",
    );
  });

  test("shows an empty state when Germany has no values", async ({ page }) => {
    await open(page, "tag=2026-03-01");
    await expect(germany(page)).toContainText("Keine Daten für diesen Tag");
    await expect(germany(page)).toContainText("Datenlücke: 24 h fehlen");
    await expect(germany(page).getByRole("img")).toHaveCount(0);
  });

  test("a day without enough reference days has a neutral symbol and says why", async ({
    page,
  }) => {
    await open(page, "tag=2026-04-04");
    await expect(germany(page).getByRole("img")).toHaveAccessibleName(
      "Kein Vergleich möglich: zu wenige Vergleichstage",
    );
    await expect(germany(page)).toContainText(
      "Sa., 04.04.2026 · 78,9 % pünktlich · kein Vergleich möglich",
    );
  });
});

test.describe("the station panel", () => {
  test("shows the day's values each next to its normal, and the sample", async ({ page }) => {
    await open(page, `tag=${DAY}&bhf=8000207`);
    const p = panel(page);
    await expect(p.getByRole("heading", { level: 2 })).toHaveText("Köln Hbf");
    await expect(p).toContainText("n = 3.000 Halte · Di., 15.09.2026");
    // Punctuality 50 % against 80 %, typical delay 4 against 3 min, P90 and cancellations as usual.
    await expect(p).toContainText("50 %");
    await expect(p).toContainText("üblich 80 % · viel schlechter");
    await expect(p).toContainText("üblich 3 min · schlechter");
    await expect(p).toContainText("üblich 12 min · wie üblich");
    await expect(p).toContainText("üblich 3,0 % · wie üblich");
  });

  test("a station without a normal says so, and one with little data shows no comparison", async ({
    page,
  }) => {
    await open(page, `tag=${DAY}&bhf=8000700`);
    await expect(panel(page)).toContainText("kein Vergleich möglich");
    await expect(panel(page)).not.toContainText("üblich");
    await page.goto(`/karte?tag=${DAY}&bhf=8000999`);
    await expect(panel(page)).toContainText("Wenig Daten (n = 9)");
    await expect(panel(page)).not.toContainText("üblich");
  });

  test("Alle Details opens the station page, which drops tag", async ({ page }) => {
    await open(page, `tag=${DAY}&bhf=8000207`);
    await panel(page).getByRole("link", { name: "Alle Details" }).click();
    await expect(page).toHaveURL(/\/bahnhof\/8000207$/);
  });
});

test.describe("375 px", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test("the day map has no sideways scroll, with the legend open too", async ({ page }) => {
    await open(page);
    await fontsReady(page);
    await openLegend(page);
    const fits = () =>
      page.evaluate(() => ({
        page: document.documentElement.scrollWidth <= innerWidth,
        card: (() => {
          const r = document.querySelector("[data-testid=map-card]")!;
          const b = r.getBoundingClientRect();
          return b.left >= 0 && b.right <= innerWidth;
        })(),
      }));
    expect(await fits()).toEqual({ page: true, card: true });
    for (const box of [await germany(page).boundingBox(), await legend(page).boundingBox()]) {
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    }
    // The cards of the bottom left stand clear of the filter card on top.
    const top = (await page.getByTestId("map-card").boundingBox())!;
    const cardBox = (await germany(page).boundingBox())!;
    expect(cardBox.y).toBeGreaterThanOrEqual(top.y + top.height);
  });

  test("the switch and the day picker are reachable by their roles", async ({ page }) => {
    await open(page);
    await expect(mode(page).getByRole("button", { name: "Tag", exact: true })).toBeVisible();
    await expect(page.getByLabel("Tag auswählen")).toBeAttached();
  });
});
