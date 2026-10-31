import { expect, test, type Page } from "@playwright/test";
import {
  datenstandHeute,
  fontsReady,
  heuteKarte,
  mockApi,
  NOT_FOUND,
  TODAY,
  tageskarteFixture,
  type Sources,
} from "./fixtures";

const CORS = { "access-control-allow-origin": "*" };

const DAY = "2026-09-15";
const map = (page: Page) => page.getByTestId("map");
const panel = (page: Page) => page.getByRole("complementary");
const legend = (page: Page) => page.getByRole("region", { name: "Legende" });
const germany = (page: Page) => page.getByRole("region", { name: "Deutschland an diesem Tag" });
const chips = (page: Page) => page.getByRole("group", { name: "Letzte Tage" });
const dayRequests = (requests: URL[]) => requests.filter((u) => u.pathname === "/tageskarte");

/** The Live-Lage page on `tag`, with the map drawn. */
async function open(page: Page, query = `tag=${DAY}`) {
  const requests = await mockApi(page);
  await page.goto(query ? `/lage?${query}` : "/lage");
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
 * MapPage (the filter card's bottom edge plus 12 px on top).
 */
async function locate(page: Page, [lon, lat]: readonly [number, number], isMobile: boolean) {
  const box = (await map(page).boundingBox())!;
  const card = (await page.getByTestId("map-card").boundingBox())!;
  const mercator = (lo: number, la: number) => ({
    x: (lo + 180) / 360,
    y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360)) / (2 * Math.PI),
  });
  const top = card.y + card.height + 12 - box.y;
  const { bottom, left, right } = isMobile
    ? { bottom: 40, left: 8, right: 8 }
    : { bottom: 24, left: 24, right: 24 };
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

test("the Karte has no day mode: no Tag switch, and a tag in the URL is dropped", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto(`/karte?g=fern&von=2026-03&bis=2026-09&tag=${DAY}`);
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await expect(page).toHaveURL(/\/karte\?g=fern&von=2026-03&bis=2026-09$/);
  await expect(page.getByLabel("Zeitraum von")).toBeVisible();
  await expect(page.getByRole("group", { name: "Zeitraum oder Tag" })).toHaveCount(0);
  await expect(page.getByLabel("Tag auswählen")).toHaveCount(0);
  await expect(chips(page)).toHaveCount(0);
  expect(dayRequests(requests)).toHaveLength(0);
});

test("the Live-Lage page has no Gattung and no period, ignores g, von and bis and keeps them in the URL", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto(`/lage?g=fern&von=2026-03&bis=2026-09&tag=${DAY}&k=p90`);
  await expect(page).toHaveURL(
    new RegExp(`/lage\\?g=fern&von=2026-03&bis=2026-09&tag=${DAY}&k=p90$`),
  );
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await expect(page.getByLabel("Gattung:")).toHaveCount(0);
  await expect(page.getByLabel("Zeitraum von")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Bahnhof/ })).toBeVisible();
  // The kept Gattung does not show: the legend names all trains.
  await openLegend(page);
  await expect(legend(page)).toContainText("Alle Gattungen");
  const asked = dayRequests(requests);
  expect(asked).toHaveLength(1);
  expect(asked[0].searchParams.has("gattung")).toBe(false);
  expect(requests.filter((u) => u.pathname === "/karte")).toHaveLength(0);
});

test("Karte, Live-Lage and back to the Karte keep the Gattung and the period", async ({ page }) => {
  await mockApi(page);
  await page.goto("/karte?g=fern&von=2026-03&bis=2026-09");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await nav.getByRole("link", { name: "Live-Lage" }).click();
  await expect(page).toHaveURL(/\/lage\?g=fern&von=2026-03&bis=2026-09$/);
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await nav.getByRole("link", { name: "Karte" }).click();
  await expect(page).toHaveURL(/\/karte\?g=fern&von=2026-03&bis=2026-09$/);
  await expect(page.getByLabel("Zeitraum von")).toHaveValue("2026-03");
});

test.describe("the last 7 days", () => {
  const press = (page: Page, name: string) =>
    chips(page).getByRole("button", { name, exact: true });

  test("are the newest day and the six before it, and the newest one removes tag", async ({
    page,
  }) => {
    const requests = await open(page);
    // The data ends on Wednesday 2026-09-30, so there is no today.
    const names = ["Mi 30", "Di 29", "Mo 28", "So 27", "Sa 26", "Fr 25", "Do 24"];
    await expect(chips(page).getByRole("button")).toHaveText(names);
    for (const name of names)
      await expect(press(page, name)).toHaveAttribute("aria-pressed", "false");

    await press(page, "Di 29").click();
    await expect(page).toHaveURL(/\/lage\?tag=2026-09-29$/);
    await expect(press(page, "Di 29")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Tag auswählen")).toHaveValue("2026-09-29");

    await press(page, "Mi 30").click();
    await expect(page).toHaveURL(/\/lage$/);
    await expect(press(page, "Mi 30")).toHaveAttribute("aria-pressed", "true");
    await expect(press(page, "Di 29")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByLabel("Tag auswählen")).toHaveValue("2026-09-30");
    await expect
      .poll(() => dayRequests(requests).map((u) => u.searchParams.get("tag")))
      .toEqual([DAY, "2026-09-29", "2026-09-30"]);
  });

  test("start with Heute, skip the days the data does not have yet and open the page on it", async ({
    page,
  }) => {
    await openToday(page, "");
    // 2026-10-01 lies between the last complete day and today: it has no map, so no chip.
    await expect(chips(page).getByRole("button")).toHaveText([
      "Heute",
      "Mi 30",
      "Di 29",
      "Mo 28",
      "So 27",
      "Sa 26",
      "Fr 25",
    ]);
    await expect(press(page, "Heute")).toHaveAttribute("aria-pressed", "true");
    await press(page, "Mi 30").click();
    await expect(page).toHaveURL(/\/lage\?tag=2026-09-30$/);
    await expect(press(page, "Heute")).toHaveAttribute("aria-pressed", "false");
    await press(page, "Heute").click();
    await expect(page).toHaveURL(/\/lage$/);
    await expect(press(page, "Heute")).toHaveAttribute("aria-pressed", "true");
  });

  test("do not go back before the first day of the data", async ({ page }) => {
    await openToday(page, "", "live", () => ({ ...noToday(), erster_tag: "2026-09-27" }));
    await expect(chips(page).getByRole("button")).toHaveText(["Mi 30", "Di 29", "Mo 28", "So 27"]);
  });

  test("the date field takes the newest day out of the URL too", async ({ page }) => {
    await open(page);
    await page.getByLabel("Tag auswählen").fill("2026-09-30");
    await expect(page).toHaveURL(/\/lage$/);
    await expect(press(page, "Mi 30")).toHaveAttribute("aria-pressed", "true");
  });
});

test("the metric switch writes k without a new request", async ({ page }) => {
  const requests = await open(page);
  await page.getByRole("button", { name: "Typische Verspätung" }).click();
  await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}&k=median$`));
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
  await expect(page).toHaveURL(/\/lage\?tag=2026-09-10$/);
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
  await expect(page).toHaveURL(/\/lage\?tag=2026-09-09$/);
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
  await page.goto(`/lage?tag=${DAY}`);
  await expect(page.getByRole("alert")).toContainText("Daten konnten nicht geladen werden.");
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  await expect(germany(page)).toContainText("Di., 15.09.2026");
});

test("without a tag the page opens on the newest day; a day outside the data moves to its edge", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/lage");
  await expect(page).toHaveURL(/\/lage$/);
  await expect(page.getByLabel("Tag auswählen")).toHaveValue("2026-09-30");
  await expect
    .poll(() => dayRequests(requests).map((u) => u.searchParams.get("tag")))
    .toEqual(["2026-09-30"]);
  // After the newest day: the newest day, which is the default and so not written.
  await page.goto("/lage?tag=2030-01-01");
  await expect(page).toHaveURL(/\/lage$/);
  await page.goto("/lage?tag=2020-01-01");
  await expect(page).toHaveURL(/\/lage\?tag=2024-07-01$/);
  // An impossible day is no tag at all.
  await page.goto("/lage?tag=2026-02-31");
  await expect(page).toHaveURL(/\/lage$/);
  await expect(page.getByLabel("Tag auswählen")).toHaveValue("2026-09-30");
});

test("the other pages and the Karte drop tag", async ({ page }) => {
  await mockApi(page);
  for (const path of [
    "/karte",
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
    await page.goto(`/lage?tag=${DAY}`);
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

    test("the chips, the steps and the card read English", async ({ page }) => {
      await mockApi(page);
      await page.goto(`/lage?tag=${DAY}`);
      await expect(map(page)).toHaveAttribute("data-ready", "true");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Live situation");
      await expect(
        page.getByRole("group", { name: "Recent days" }).getByRole("button").first(),
      ).toHaveText("Wed 30");
      await openLegend(page);
      const l = page.getByRole("region", { name: "Legend" });
      for (const text of ["much better", "as usual", "much worse", "no comparison possible"])
        await expect(l).toContainText(text);
      await expect(l).toContainText("Reference days: 12 × Tuesday from the 12 weeks before");
      const card = page.getByRole("region", { name: "Germany on this day" });
      await expect(card.getByRole("img")).toHaveAccessibleName(
        "Thunderstorm: much worse than usual",
      );
      await expect(card).toContainText("Long-distance · 44.6% on time · usual 43.0%");
      await expect(card).toContainText("Regional · 76.9% on time · usual 79.0%");
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

  test("has a Fern and a Regional line under the main line, each against its usual", async ({
    page,
  }) => {
    await open(page);
    const card = germany(page);
    await expect(card).toContainText("Fernverkehr · 44,6 % pünktlich · üblich 43,0 %");
    await expect(card).toContainText("Regionalverkehr · 76,9 % pünktlich · üblich 79,0 %");
    await page.getByRole("button", { name: "Ausfälle", exact: true }).click();
    await expect(card).toContainText("Fernverkehr · 8,0 % ausgefallen · üblich 7,0 %");
    await expect(card).toContainText("Regionalverkehr · 5,4 % ausgefallen · üblich 4,0 %");
    // The main line is the one of all trains and stays first.
    await expect(card.locator("p").nth(1)).toContainText("5,9 % ausgefallen · üblich 4,2 %");
  });

  test("a category without a usual says so, and one the API leaves out has no line", async ({
    page,
  }) => {
    await open(page, "tag=2026-04-04");
    await expect(germany(page)).toContainText(
      "Fernverkehr · 44,6 % pünktlich · kein Vergleich möglich",
    );
    const day = (tag: string) => ({ ...tageskarteFixture(tag), deutschland_fern: null });
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
    await page.goto(`/lage?tag=${DAY}`);
    await expect(germany(page)).toContainText("Regionalverkehr · 76,9 % pünktlich");
    await expect(germany(page)).not.toContainText("Fernverkehr");
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
      await page.goto(`/lage?tag=${DAY}`);
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
    await expect(germany(page)).not.toContainText("Fernverkehr");
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
    await page.goto(`/lage?tag=${DAY}&bhf=8000999`);
    await expect(panel(page)).toContainText("Wenig Daten (n = 9)");
    await expect(panel(page)).not.toContainText("üblich");
  });

  test("a station outside the large ones says the page shows only those", async ({ page }) => {
    await open(page, `tag=${DAY}&bhf=08002549`);
    await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Hamburg Hbf");
    await expect(panel(page)).toContainText("Die Live-Lage zeigt nur die großen Bahnhöfe.");
    await expect(panel(page)).not.toContainText("mit diesen Filtern");
  });

  test("Alle Details opens the station page, which drops tag", async ({ page }) => {
    await open(page, `tag=${DAY}&bhf=8000207`);
    await panel(page).getByRole("link", { name: "Alle Details" }).click();
    await expect(page).toHaveURL(/\/bahnhof\/8000207$/);
  });
});

/**
 * The page on a server that has a "today" from `sources`: live data at 14:37 (arrivals before
 * 14:00 counted), rest data at 09:37 (before 09:00), or both. Without a `tag` it opens on today.
 */
async function openToday(
  page: Page,
  query = "",
  sources: Sources = "live",
  datenstand = () => datenstandHeute(sources),
  karte = (tag: string): ReturnType<typeof heuteKarte> | typeof NOT_FOUND =>
    tag === TODAY ? heuteKarte(sources) : tageskarteFixture(tag),
) {
  const none = [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ] as const;
  const requests = await mockApi(page, ...none, karte, datenstand);
  await page.goto(query ? `/lage?${query}` : "/lage");
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  return requests;
}

/** /datenstand once the data went stale: no today any more. */
const noToday = () => ({
  ...datenstandHeute(),
  heute: null,
  heute_stand: null,
  heute_stand_rest: null,
});
/** The card of today; it reads "Deutschland" like any day's. */
const todayCard = (page: Page) => page.getByRole("region", { name: "Deutschland heute" });

/** Hovers a station and returns the tooltip; the page was opened on a tall viewport. */
async function tooltipOf(page: Page, station: readonly [number, number]) {
  await fontsReady(page);
  const at = await locate(page, station, false);
  await page.mouse.move(at.x + 150, at.y + 150);
  await page.mouse.move(at.x, at.y);
  return page.getByRole("tooltip");
}

test.describe("today", () => {
  test("the day field reaches today, and Heute opens it without a tag", async ({ page }) => {
    const requests = await openToday(page, `tag=${DAY}`);
    const picker = page.getByLabel("Tag auswählen");
    await expect(picker).toHaveAttribute("max", TODAY);
    const button = page.getByRole("button", { name: "Heute", exact: true });
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await button.click();
    await expect(page).toHaveURL(/\/lage$/);
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(picker).toHaveValue(TODAY);
    await expect
      .poll(() => dayRequests(requests).map((u) => u.searchParams.get("tag")))
      .toEqual([DAY, TODAY]);
  });

  test("without a tag the page opens on today", async ({ page }) => {
    const requests = await openToday(page);
    await expect(page).toHaveURL(/\/lage$/);
    await expect(page.getByLabel("Tag auswählen")).toHaveValue(TODAY);
    await expect(page.getByRole("button", { name: "Heute", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(dayRequests(requests).map((u) => u.searchParams.get("tag"))).toEqual([TODAY]);
  });

  test("a day after today moves to today", async ({ page }) => {
    await openToday(page, "tag=2030-01-01");
    await expect(page).toHaveURL(/\/lage$/);
  });

  test("a day between the last complete one and today has no data and moves to today", async ({
    page,
  }) => {
    const requests = await openToday(page, "tag=2026-10-01");
    await expect(page).toHaveURL(/\/lage$/);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(dayRequests(requests).map((u) => u.searchParams.get("tag"))).not.toContain("2026-10-01");
  });

  test("the card and the legend name the data time and the cut, the card Germany", async ({
    page,
  }) => {
    await openToday(page);
    await expect(todayCard(page)).toContainText("Deutschland");
    await expect(todayCard(page)).toContainText("Heute, Stand 14:37 · bis 14:00");
    await expect(todayCard(page)).not.toContainText("Di., ");
    await expect(germany(page)).toHaveCount(0);
    await openLegend(page);
    await expect(legend(page)).toContainText("Große Bahnhöfe live: Stand 14:37 · bis 14:00");
    await expect(legend(page)).toContainText("Heute · Alle Gattungen · Bahnhöfe auf der Karte: 6");
    await expect(legend(page)).not.toContainText("Übrige");
    await expect(legend(page)).not.toContainText("Alle Bahnhöfe");
    await expect(legend(page)).toContainText("12 × Freitag");
  });

  test("with both sources the legend has a line for each and the card follows the live one", async ({
    page,
  }) => {
    await openToday(page, "", "both");
    await openLegend(page);
    await expect(legend(page)).toContainText("Große Bahnhöfe live: Stand 14:37 · bis 14:00");
    await expect(legend(page)).toContainText("Übrige große Bahnhöfe: Stand 09:37 · bis 09:00");
    await expect(todayCard(page)).toContainText("Heute, Stand 14:37 · bis 14:00");
  });

  test("with only the rest the legend has one line and the card names Germany with its stand", async ({
    page,
  }) => {
    await openToday(page, "", "rest");
    await openLegend(page);
    await expect(legend(page)).toContainText("Große Bahnhöfe: Stand 09:37 · bis 09:00");
    await expect(legend(page)).not.toContainText("live");
    await expect(legend(page)).not.toContainText("Übrige");
    await expect(todayCard(page)).toContainText("Deutschland");
    await expect(todayCard(page)).toContainText("Heute, Stand 09:37 · bis 09:00");
  });

  test("only rest data still gives the Heute button, which opens today", async ({ page }) => {
    await openToday(page, `tag=${DAY}`, "rest");
    const button = page.getByRole("button", { name: "Heute", exact: true });
    await expect(page.getByLabel("Tag auswählen")).toHaveAttribute("max", TODAY);
    await button.click();
    await expect(page).toHaveURL(/\/lage$/);
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(todayCard(page)).toBeVisible();
  });

  test("the tooltip names the stand of the station's own source", async ({ page, isMobile }) => {
    test.skip(isMobile, "needs a hover");
    // Tall enough that the cards of the bottom left do not stand over Köln.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openToday(page, "", "both");
    const tip = await tooltipOf(page, STATIONS.koeln);
    await expect(tip).toHaveText(
      "Köln Hbf · 50 % · üblich 80 % · viel schlechter · Stand 14:37 · bis 14:00",
    );
    const other = await locate(page, STATIONS.ueblingen, false);
    await page.mouse.move(other.x, other.y);
    await expect(tip).toHaveText(
      "Üblingen · 81 % · üblich 80 % · wie üblich · Stand 09:37 · bis 09:00",
    );
  });

  test("the panel names the stand of the station's own source", async ({ page }) => {
    await openToday(page, `bhf=8000600`, "both");
    await expect(panel(page)).toContainText("n = 1.200 Halte · Heute, Stand 09:37 · bis 09:00");
    await page.goto(`/lage?bhf=8000207`);
    await expect(panel(page)).toContainText("n = 3.000 Halte · Heute, Stand 14:37 · bis 14:00");
  });

  test("a station without data today says so in the panel", async ({ page }) => {
    await openToday(page, `bhf=8000555`);
    const p = panel(page);
    await expect(p.getByRole("heading", { level: 2 })).toHaveText("Problemhausen");
    await expect(p).toContainText("Heute liegen noch keine Daten für diesen Bahnhof vor.");
    await expect(p).not.toContainText("üblich");
    await expect(p).not.toContainText("Wenig Daten");
    await expect(p.getByRole("link", { name: "Alle Details" })).toBeVisible();
  });

  test("a station with data today is shown as on any day", async ({ page }) => {
    await openToday(page, `bhf=8000207`);
    await expect(panel(page)).toContainText("üblich 80 % · viel schlechter");
    await expect(panel(page)).toContainText("n = 3.000 Halte · Heute, Stand 14:37 · bis 14:00");
  });

  test("the tooltip of a station without data today", async ({ page, isMobile }) => {
    test.skip(isMobile, "needs a hover");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openToday(page);
    const tip = await tooltipOf(page, STATIONS.problemhausen);
    await expect(tip).toHaveText("Problemhausen · noch keine Daten für heute");
  });

  test("the legend has a key for the stations without data today, a past day has none", async ({
    page,
  }) => {
    await openToday(page);
    await openLegend(page);
    await expect(legend(page)).toContainText("noch keine Daten für heute");
    await page.goto(`/lage?tag=${DAY}`);
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    await openLegend(page);
    await expect(legend(page)).toContainText("sehr wenig Daten");
    await expect(legend(page)).not.toContainText("noch keine Daten für heute");
  });

  test("a past day keeps its date labels", async ({ page }) => {
    await openToday(page, `tag=${DAY}`);
    await expect(germany(page)).toContainText("Deutschland");
    await expect(germany(page)).toContainText("Di., 15.09.2026");
    await expect(germany(page)).not.toContainText("Stand");
  });

  test("without a today there is no Heute button and the days end at the last complete one", async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByLabel("Tag auswählen")).toHaveAttribute("max", "2026-09-30");
    await expect(page.getByRole("button", { name: "Heute", exact: true })).toHaveCount(0);
    // The last complete day is the newest, so it is the default and not written.
    await page.goto("/lage?tag=2026-10-01");
    await expect(page).toHaveURL(/\/lage$/);
    await expect(page.getByLabel("Tag auswählen")).toHaveValue("2026-09-30");
  });

  test("an open tab refetches today every 5 minutes and, when today is gone, lands on the last day", async ({
    page,
  }) => {
    let today = true;
    await page.clock.install();
    const requests = await openToday(page, "", "live", () =>
      today ? datenstandHeute() : noToday(),
    );
    const asked = () => dayRequests(requests).map((u) => u.searchParams.get("tag"));
    expect(asked()).toEqual([TODAY]);
    await page.clock.fastForward("05:01");
    await expect.poll(asked).toEqual([TODAY, TODAY]);
    // No refocus: the tab asks /datenstand itself, and the day moves to the last complete one.
    today = false;
    await page.clock.fastForward("05:01");
    await expect.poll(asked).toContain("2026-09-30");
    await expect(page).toHaveURL(/\/lage$/);
    await expect(page.getByLabel("Tag auswählen")).toHaveValue("2026-09-30");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a tab left open across midnight asks /datenstand at once when today's map is gone", async ({
    page,
  }) => {
    // Yesterday's "today" is a 404 from the first refetch on; /datenstand knows that only after a
    // request that comes after the 404, so the tab has to ask again because of it.
    let midnight = false;
    let notFound = false;
    await page.clock.install();
    const requests = await openToday(
      page,
      "",
      "live",
      () => (notFound ? noToday() : datenstandHeute()),
      (tag) => {
        if (tag !== TODAY) return tageskarteFixture(tag);
        if (!midnight) return heuteKarte("live");
        notFound = true;
        return NOT_FOUND;
      },
    );
    const asked = () => requests.filter((u) => u.pathname === "/datenstand").length;
    const before = asked();
    midnight = true;
    await page.clock.fastForward("05:01");
    await expect(page.getByLabel("Tag auswählen")).toHaveValue("2026-09-30");
    await expect(page.getByRole("alert")).toHaveCount(0);
    // One request for the poll and one because of the 404; the poll alone would make one.
    expect(asked()).toBeGreaterThanOrEqual(before + 2);
  });

  test("a past day is not polled", async ({ page }) => {
    await page.clock.install();
    const requests = await openToday(page, `tag=${DAY}`);
    await page.clock.fastForward("05:01");
    // Today's request is later than a wrongly armed poll of the past day, so the check can fail.
    await page.getByRole("button", { name: "Heute", exact: true }).click();
    await expect(page).toHaveURL(/\/lage$/);
    await expect
      .poll(() => dayRequests(requests).map((u) => u.searchParams.get("tag")))
      .toContain(TODAY);
    expect(
      dayRequests(requests)
        .map((u) => u.searchParams.get("tag"))
        .filter((d) => d === DAY),
    ).toHaveLength(1);
  });

  test("a failed background refetch of /datenstand leaves the working map alone", async ({
    page,
  }) => {
    await page.clock.install();
    await openToday(page, `tag=${DAY}`);
    let failed = 0;
    await page.route(
      (url) => url.pathname === "/datenstand",
      (route) => {
        failed++;
        return route.fulfill({ status: 500, headers: CORS, body: "" });
      },
    );
    await page.clock.fastForward("05:01");
    await expect.poll(() => failed).toBeGreaterThan(0);
    // Time for the failure to reach the page.
    await page.waitForTimeout(300);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(germany(page)).toContainText("Di., 15.09.2026");
  });

  test.describe("English", () => {
    test.use({ locale: "en-US" });

    test("the labels read English", async ({ page }) => {
      await openToday(page);
      const card = page.getByRole("region", { name: "Germany today" });
      await expect(card).toContainText("Germany");
      await expect(card).toContainText("Today, as of 14:37 · up to 14:00");
      await expect(page.getByRole("button", { name: "Today", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.goto("/lage?bhf=8000555");
      await expect(panel(page)).toContainText("No data for this station yet today.");
    });

    test("the legend lines and the rest-only card read English", async ({ page }) => {
      await openToday(page, "", "both");
      await openLegend(page);
      const l = page.getByRole("region", { name: "Legend" });
      await expect(l).toContainText("Large stations live: as of 14:37 · up to 14:00");
      await expect(l).toContainText("Other large stations: as of 09:37 · up to 09:00");
      await openToday(page, "", "rest");
      await openLegend(page);
      await expect(l).toContainText("Large stations: as of 09:37 · up to 09:00");
      await expect(l).not.toContainText("live");
      await expect(page.getByRole("region", { name: "Germany today" })).toContainText(
        "Today, as of 09:37 · up to 09:00",
      );
    });
  });
});

test.describe("375 px", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test("the page has no sideways scroll, with the legend open too", async ({ page }) => {
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

  test("the chips scroll in one row with the other filters and all seven are reachable", async ({
    page,
  }) => {
    await open(page);
    await fontsReady(page);
    await expect(chips(page).getByRole("button")).toHaveCount(7);
    await expect(page.getByLabel("Tag auswählen")).toBeAttached();
    const rows = new Set<number>();
    for (const chip of await chips(page).getByRole("button").all()) {
      await chip.scrollIntoViewIfNeeded();
      await expect(chip).toBeVisible();
      rows.add(Math.round((await chip.boundingBox())!.y));
    }
    // One row: the chips do not wrap, the row scrolls sideways inside the card.
    expect(rows.size).toBe(1);
    const scrolls = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(scrolls).toBe(true);
  });
});
