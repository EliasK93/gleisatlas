import { expect, test, type Locator, type Page } from "@playwright/test";
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
/** The browser's clock in the Live-Lage tests: TODAY in Berlin, after the collector's run. */
const NOW = new Date(`${TODAY}T14:40:00+02:00`);

/** The Live-Lage page on `tag`, with the map drawn, on a browser whose day is TODAY. */
async function open(page: Page, query = `tag=${DAY}`) {
  await page.clock.setSystemTime(NOW);
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
 * MapPage (on desktop the filter card's bottom edge plus 12 px on top; on a phone 140 px on top and
 * the bottom cards, whose top is the Germany card's, plus 12 px).
 */
async function locate(
  page: Page,
  [lon, lat]: readonly [number, number],
  isMobile: boolean,
  // Steps of the zoom buttons since the start view, which zoom around the map's centre.
  zoom = 0,
) {
  const box = (await map(page).boundingBox())!;
  const card = (await page.getByTestId("map-card").boundingBox())!;
  const mercator = (lo: number, la: number) => ({
    x: (lo + 180) / 360,
    y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360)) / (2 * Math.PI),
  });
  const { top, bottom, left, right } = isMobile
    ? {
        top: 140,
        bottom: box.y + box.height - (await germany(page).boundingBox())!.y + 12,
        left: 8,
        right: 8,
      }
    : { top: card.y + card.height + 12 - box.y, bottom: 24, left: 24, right: 24 };
  const sw = mercator(5.9, 47.3);
  const ne = mercator(15.0, 55.05);
  const w = box.width - left - right;
  const h = box.height - top - bottom;
  const scale = Math.min(w / (ne.x - sw.x), h / (sw.y - ne.y));
  const p = mercator(lon, lat);
  const x = box.x + left + w / 2 + (p.x - (sw.x + ne.x) / 2) * scale;
  const y = box.y + top + h / 2 + (p.y - (sw.y + ne.y) / 2) * scale;
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  return {
    x: Math.round(cx + (x - cx) * 2 ** zoom),
    y: Math.round(cy + (y - cy) * 2 ** zoom),
  };
}

/**
 * Opens the page on `query` with the station `eva` picked: the map moves it next to the panel at
 * zoom 9, past the overview, so the dots are drawn in full. Returns where the station ends up.
 */
async function focus(page: Page, eva: string, isMobile: boolean, query = `tag=${DAY}`) {
  await page.goto(`/lage?${query}&bhf=${eva}`);
  await expect(map(page)).toHaveAttribute("data-ready", "true");
  const box = (await map(page).boundingBox())!;
  // MapPage's offset: left of the centre on desktop, above the sheet on a phone.
  return {
    x: Math.round(box.x + box.width / 2 - (isMobile ? 0 : 180)),
    y: Math.round(box.y + box.height / 2 - (isMobile ? box.height * 0.3 : 0)),
  };
}

/**
 * The colour of the rendered pixel at a point, read from a screenshot with the overlays hidden,
 * and the state cards too unless `cards` stay (hiding a focused card would blur it).
 */
async function colourAt(page: Page, { x, y }: { x: number; y: number }, cards = false) {
  const hide = await page.addStyleTag({
    content: `main > div > :not(:first-child)${cards ? "" : ", .maplibregl-marker"} { visibility: hidden }`,
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

/** The rendered colour of an element near its left edge, half way down (clear of its text). */
async function fillOf(el: Locator) {
  const png = (await el.screenshot({ scale: "css" })).toString("base64");
  return el.page().evaluate(async (data) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${data}`)).blob(),
    );
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const [r, g, b] = ctx.getImageData(3, Math.floor(bitmap.height / 2), 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }, png);
}

/** `colour` laid over `under` with `alpha`, as three numbers. */
const blend = (colour: string, under: string, alpha: number) =>
  rgb(colour).map((c, i) => Math.round(alpha * c + (1 - alpha) * rgb(under)[i]));
/** The largest channel difference between two colours. */
const distance = (a: number[], b: number[]) => Math.max(...a.map((c, i) => Math.abs(c - b[i])));

/** Hovers a point until the tooltip settles (the map may still be easing) and returns its text. */
const tipAt = (page: Page, { x, y }: { x: number; y: number }) =>
  expect.poll(async () => {
    await page.mouse.move(x + 150, y + 150);
    await page.mouse.move(x, y);
    // Spaced like toHaveText: a no-break space reads as a space.
    return (await page.getByRole("tooltip").allTextContents()).join("").replace(/\s+/g, " ");
  });

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

test.describe("the day chips", () => {
  const press = (page: Page, name: string) =>
    chips(page).getByRole("button", { name, exact: true });

  test("are Heute, Gestern and Vorgestern; a day without a map is disabled and says why, and the newest day removes tag", async ({
    page,
  }) => {
    // The browser's day is 2026-10-02; the data ends on 2026-09-30 (Vorgestern) without a today.
    const requests = await open(page);
    await expect(chips(page).getByRole("button")).toHaveText(["Heute", "Gestern", "Vorgestern"]);
    await expect(press(page, "Heute")).toBeDisabled();
    await expect(press(page, "Heute")).toHaveAccessibleDescription("noch keine Daten für heute");
    await expect(press(page, "Gestern")).toBeDisabled();
    await expect(press(page, "Gestern")).toHaveAccessibleDescription("noch nicht vollständig");
    await expect(press(page, "Vorgestern")).toBeEnabled();
    // A disabled chip takes no focus and a touch shows no title: the reason is also page text.
    const why = await press(page, "Heute").getAttribute("aria-describedby");
    await expect(page.locator(`[id="${why}"]`)).toHaveText("noch keine Daten für heute");
    for (const name of ["Heute", "Gestern", "Vorgestern"])
      await expect(press(page, name)).toHaveAttribute("aria-pressed", "false");

    await press(page, "Vorgestern").click();
    await expect(page).toHaveURL(/\/lage$/);
    await expect(press(page, "Vorgestern")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Tag auswählen")).toHaveValue("2026-09-30");
    await expect
      .poll(() => dayRequests(requests).map((u) => u.searchParams.get("tag")))
      .toEqual([DAY, "2026-09-30"]);
  });

  test("with a today, Heute opens it without a tag and Gestern waits until it is complete", async ({
    page,
  }) => {
    await openToday(page, "");
    // 2026-10-01 lies between the last complete day and today: it has no map yet.
    await expect(press(page, "Heute")).toHaveAttribute("aria-pressed", "true");
    await expect(press(page, "Gestern")).toBeDisabled();
    await expect(press(page, "Gestern")).toHaveAccessibleDescription("noch nicht vollständig");
    await press(page, "Vorgestern").click();
    await expect(page).toHaveURL(/\/lage\?tag=2026-09-30$/);
    await expect(press(page, "Heute")).toHaveAttribute("aria-pressed", "false");
    await expect(press(page, "Vorgestern")).toHaveAttribute("aria-pressed", "true");
    await press(page, "Heute").click();
    await expect(page).toHaveURL(/\/lage$/);
    await expect(press(page, "Heute")).toHaveAttribute("aria-pressed", "true");
  });

  test("a day older than Vorgestern has no chip pressed", async ({ page }) => {
    await open(page);
    for (const name of ["Heute", "Gestern", "Vorgestern"])
      await expect(press(page, name)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByLabel("Tag auswählen")).toHaveValue(DAY);
  });

  test("the date field takes the newest day out of the URL too", async ({ page }) => {
    await open(page);
    await page.getByLabel("Tag auswählen").fill("2026-09-30");
    await expect(page).toHaveURL(/\/lage$/);
    await expect(press(page, "Vorgestern")).toHaveAttribute("aria-pressed", "true");
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

test("the other pages and the Karte drop land", async ({ page }) => {
  await mockApi(page);
  for (const path of [
    "/karte",
    "/muster/heatmap",
    "/muster/rankings",
    "/muster/zeitverlauf",
    "/bahnhof/8000207",
  ]) {
    await page.goto(`${path}?g=fern&land=nw`);
    await expect(page).toHaveURL(new RegExp(`${path}\\?g=fern$`));
  }
});

/** The state cards on the map; each is named "state · deviation · step" or its reason. */
const states = (page: Page) => map(page).getByRole("button", { name: / · / });
const state = (page: Page, name: string) =>
  map(page).getByRole("button", { name: new RegExp(`^${name} · `) });
/** "#rrggbb" or "rgb(r, g, b)" as three numbers. */
const rgb = (colour: string) =>
  colour.startsWith("#")
    ? [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16))
    : colour.match(/\d+/g)!.map(Number);
/** The e2e stand-in base map's background (light). */
const BASE = "#eef0f3";
const STEPS = [1, 2, 3, 4, 5, null] as const;
const STEP_NAMES = ["viel besser", "besser", "wie üblich", "schlechter", "viel schlechter"];
/** The day map with Nordrhein-Westfalen's punctuality class set to `cls`. */
const withNw = (cls: number | null) => (tag: string) => {
  const fixture = tageskarteFixture(tag);
  fixture.laender[0].alle.klasse.puenktlich = cls;
  return fixture;
};
const mockDay = (page: Page, day: (tag: string) => ReturnType<typeof tageskarteFixture>) =>
  mockApi(page, undefined, undefined, undefined, undefined, undefined, undefined, undefined, day);

test.describe("the states", () => {
  test("the overview shows a card for each of the 16 states, named by the state, its deviation and its step", async ({
    page,
  }) => {
    await open(page);
    await expect(states(page)).toHaveCount(16);
    await expect(state(page, "Nordrhein-Westfalen")).toHaveAccessibleName(
      "Nordrhein-Westfalen · −30 %-Pkt. · viel schlechter",
    );
    await expect(state(page, "Hessen")).toHaveAccessibleName("Hessen · +10 %-Pkt. · viel besser");
    await expect(state(page, "Niedersachsen")).toHaveAccessibleName(
      "Niedersachsen · +1 %-Pkt. · wie üblich",
    );
    // A state without a class has no comparison; one without stops says so.
    await expect(state(page, "Bayern")).toHaveAccessibleName("Bayern · kein Vergleich möglich");
    await expect(state(page, "Bayern")).toHaveText("–");
    await expect(state(page, "Berlin")).toHaveAccessibleName("Berlin · Keine Daten für diesen Tag");
    await expect(state(page, "Berlin")).toHaveText("–");
    // The cards follow the metric.
    await page.getByRole("button", { name: "Ausfälle", exact: true }).click();
    await expect(state(page, "Nordrhein-Westfalen")).toHaveAccessibleName(
      "Nordrhein-Westfalen · +0,5 %-Pkt. · wie üblich",
    );
  });

  test("a card shows the deviation from the usual with its sign, in the metric's unit", async ({
    page,
  }) => {
    await open(page);
    const nw = state(page, "Nordrhein-Westfalen");
    for (const [button, text] of [
      ["Pünktlichkeit", "−30 %-Pkt."],
      ["Typische Verspätung", "+1 min"],
      ["Schlechteste 10 %", "±0 min"],
      ["Ausfälle", "+0,5 %-Pkt."],
    ])
      await test.step(button, async () => {
        await page.getByRole("button", { name: button, exact: true }).click();
        await expect(nw).toHaveText(text);
      });
  });

  test("a card has the colour of its step, 1 to 5, grey without a comparison and dashed without data", async ({
    page,
  }) => {
    for (const [i, cls] of STEPS.entries())
      await test.step(String(cls), async () => {
        await page.unrouteAll();
        await page.clock.setSystemTime(NOW);
        await mockDay(page, withNw(cls));
        await page.goto(`/lage?tag=${DAY}`);
        await expect(map(page)).toHaveAttribute("data-ready", "true");
        const nw = state(page, "Nordrhein-Westfalen");
        await expect(nw).toHaveAccessibleName(
          `Nordrhein-Westfalen · ${cls ? `−30 %-Pkt. · ${STEP_NAMES[i]}` : "kein Vergleich möglich"}`,
        );
        const want = await token(page, cls ? `r${cls}` : "c3");
        await expect.poll(() => fillOf(nw)).toBe(want);
      });
    const berlin = state(page, "Berlin");
    await expect(berlin).toHaveCSS("border-top-style", "dashed");
    await expect.poll(() => fillOf(berlin)).toBe(await token(page, "surface"));
  });

  test("on a day with missing hours the cards have no comparison", async ({ page }) => {
    await open(page, "tag=2026-03-14");
    await expect(state(page, "Hessen")).toHaveAccessibleName("Hessen · kein Vergleich möglich");
    await expect(state(page, "Hessen")).toHaveText("–");
  });

  test("the overview washes out the land outside Germany, on Live-Lage only", async ({
    page,
    isMobile,
  }) => {
    await open(page);
    // The North Sea west of Heligoland, inside the start view but outside every state.
    const sea = await locate(page, [6.4, 54.5], isMobile);
    const inland = await locate(page, [10.6, 50.5], isMobile);
    const washed = blend(await token(page, "mask"), BASE, 0.6);
    await expect
      .poll(async () => distance(rgb(await colourAt(page, sea)), washed))
      .toBeLessThanOrEqual(3);
    expect(distance(rgb(await colourAt(page, inland)), rgb(BASE))).toBeLessThanOrEqual(3);
    await page.goto("/karte");
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    await page.waitForTimeout(300);
    expect(distance(rgb(await colourAt(page, sea)), rgb(BASE))).toBeLessThanOrEqual(3);
  });

  test("hovering a state's area tints it and shows its tooltip, and a click picks it", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "needs a hover");
    await open(page);
    await fontsReady(page);
    // In Nordrhein-Westfalen, clear of its card and of the Köln dot.
    const inside = await locate(page, [7.6, 51.9], false);
    await tipAt(page, inside).toBe(
      "Nordrhein-Westfalen · −30 %-Pkt. · 50,0 % pünktlich · üblich 80,0 % · 1 großer Bahnhof",
    );
    const tinted = blend(await token(page, "accent"), BASE, 0.14);
    expect(distance(rgb(await colourAt(page, inside)), tinted)).toBeLessThanOrEqual(3);
    await page.mouse.click(inside.x, inside.y);
    await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}&land=nw$`));
  });

  test("a hovered or focused card tints its state's area", async ({ page, isMobile }) => {
    await open(page);
    const at = await locate(page, [7.6, 51.9], isMobile);
    const tinted = blend(await token(page, "accent"), BASE, 0.14);
    await state(page, "Nordrhein-Westfalen").focus();
    await expect
      .poll(async () => distance(rgb(await colourAt(page, at, true)), tinted))
      .toBeLessThanOrEqual(3);
    await state(page, "Nordrhein-Westfalen").blur();
    await expect
      .poll(async () => distance(rgb(await colourAt(page, at, true)), rgb(BASE)))
      .toBeLessThanOrEqual(3);
  });

  test.describe("in the dark theme", () => {
    test.use({ colorScheme: "dark" });

    test("a focused card tints its state's area at 0.3, not at the light theme's 0.14", async ({
      page,
      isMobile,
    }) => {
      await open(page);
      await fontsReady(page);
      const at = await locate(page, [7.6, 51.9], isMobile);
      const accent = rgb(await token(page, "accent"));
      // The rendered dark base map is about 7 % darker than its style's background, which scales
      // the tinted pixel too: the share of the accent is measured against the untinted pixel and
      // reads 0.3 times that, about 0.28. The light theme's 0.14 or a 0.2 are far outside.
      const base = rgb(await colourAt(page, at, true));
      await state(page, "Nordrhein-Westfalen").focus();
      await expect
        .poll(async () => {
          const now = rgb(await colourAt(page, at, true));
          const shares = now.map((c, i) => (c - base[i]) / (accent[i] - base[i]));
          return shares.reduce((a, b) => a + b) / shares.length;
        })
        .toBeCloseTo(0.28, 1);
    });
  });

  test("at the overview the dots take no hover and no click, past it they do", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "needs a hover");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page);
    await fontsReady(page);
    // Köln's dot lies in Nordrhein-Westfalen: the state answers, not the station.
    const koeln = await locate(page, STATIONS.koeln, false);
    await tipAt(page, koeln).toMatch(/^Nordrhein-Westfalen · /);
    await page.mouse.click(koeln.x, koeln.y);
    await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}&land=nw$`));

    await page.goto(`/lage?tag=${DAY}`);
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    await page.getByRole("button", { name: "Vergrößern" }).click();
    await expect(states(page)).toHaveCount(0);
    const ueblingen = await locate(page, STATIONS.ueblingen, false, 1);
    await tipAt(page, ueblingen).toBe("Üblingen · 81 % · üblich 80 % · wie üblich");
    await page.mouse.click(ueblingen.x, ueblingen.y);
    await expect(page).toHaveURL(new RegExp(`/lage\\?bhf=8000600&tag=${DAY}$`));
  });

  test("the dots are faded under the cards and full once zoomed in", async ({ page, isMobile }) => {
    await open(page);
    const full = await token(page, "r5");
    const background = rgb(BASE);
    // 20 % of the dot's colour over the base map.
    const faded = rgb(full).map((c, i) => Math.round(0.2 * c + 0.8 * background[i]));
    const koeln = await locate(page, STATIONS.koeln, isMobile);
    await expect
      .poll(async () => {
        const seen = rgb(await colourAt(page, koeln));
        return Math.max(...seen.map((c, i) => Math.abs(c - faded[i])));
      })
      .toBeLessThanOrEqual(3);
    const at = await focus(page, "8000207", isMobile);
    await expect.poll(() => colourAt(page, at)).toBe(full);
    await expect(states(page)).toHaveCount(0);
  });

  test("zooming in past the overview hides the cards, zooming out brings them back", async ({
    page,
  }) => {
    await open(page);
    await expect(states(page)).toHaveCount(16);
    await page.getByRole("button", { name: "Vergrößern" }).click();
    await expect(states(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Verkleinern" }).click();
    await expect(states(page)).toHaveCount(16);
  });

  test("a keyboard zoom past the overview from a focused card hands the focus to the map", async ({
    page,
  }) => {
    await open(page);
    await state(page, "Nordrhein-Westfalen").focus();
    // MapLibre's zoom key, which zooms two steps with Shift.
    await page.keyboard.press("Shift+Equal");
    await expect(states(page)).toHaveCount(0);
    await expect(map(page).locator("canvas")).toBeFocused();
  });

  test("a zoomed-in Live-Lage, the Karte and back: the overview has its cards and inert dots again", async ({
    page,
    isMobile,
  }) => {
    // Without a tag, which the Karte would drop (a redirect that rebuilds the page anyway).
    await open(page, "");
    await page.getByRole("button", { name: "Vergrößern" }).click();
    await expect(states(page)).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    await nav.getByRole("link", { name: "Karte" }).click();
    await expect(page).toHaveURL(/\/karte$/);
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    // Zoomed in on the Karte too, so no refit of the start view can reset the zoom state.
    await page.getByRole("button", { name: "Vergrößern" }).click();
    await page.waitForTimeout(600);
    await nav.getByRole("link", { name: "Live-Lage" }).click();
    await expect(page).toHaveURL(/\/lage$/);
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    await expect(states(page)).toHaveCount(16);
    // Köln's dot lies under Nordrhein-Westfalen's card or area: either picks the state, not the station.
    const koeln = await locate(page, STATIONS.koeln, isMobile);
    await page.mouse.click(koeln.x, koeln.y);
    await expect(page).toHaveURL(/\/lage\?land=nw$/);
  });

  test("hovering and clicking the edge of Berlin's card affects Berlin only", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "needs a hover");
    await open(page);
    await fontsReady(page);
    // The card is wider than Berlin: a few pixels inside its right edge the map below is Brandenburg.
    const card = (await state(page, "Berlin").boundingBox())!;
    const edge = {
      x: Math.round(card.x + card.width - 3),
      y: Math.round(card.y + card.height / 2),
    };
    await tipAt(page, edge).toBe("Berlin · Keine Daten für diesen Tag");
    // Brandenburg near Kyritz, clear of every card and dot, keeps the plain base map.
    const brandenburg = await locate(page, [12.4, 52.85], false);
    expect(distance(rgb(await colourAt(page, brandenburg, true)), rgb(BASE))).toBeLessThanOrEqual(
      3,
    );
    const before = await page.evaluate(() => history.length);
    await page.mouse.click(edge.x, edge.y);
    await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}&land=be$`));
    // One new history entry, so Back returns to Germany.
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
  });

  test("the deviation is the difference of the two figures as shown", async ({ page }) => {
    await page.clock.setSystemTime(NOW);
    await mockDay(page, (tag) => {
      const fixture = tageskarteFixture(tag);
      fixture.laender[0].alle.median = 1.4;
      fixture.laender[0].alle.normal.median = 1.6;
      return fixture;
    });
    await page.goto(`/lage?tag=${DAY}&k=median`);
    await expect(map(page)).toHaveAttribute("data-ready", "true");
    // "1 min verspätet · üblich 2 min" is one minute better, not ±0.
    await expect(state(page, "Nordrhein-Westfalen")).toHaveText("−1 min");
    await expect(state(page, "Nordrhein-Westfalen")).toHaveAccessibleName(
      "Nordrhein-Westfalen · −1 min · schlechter",
    );
  });

  test("a click on a state sets land and shows its card; the back button returns to Germany", async ({
    page,
  }) => {
    await open(page);
    await state(page, "Nordrhein-Westfalen").click();
    await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}&land=nw$`));
    const card = page.getByRole("region", { name: "Nordrhein-Westfalen an diesem Tag" });
    await expect(card).toContainText("Nordrhein-Westfalen");
    await expect(card).toContainText("1 großer Bahnhof");
    await expect(card).toContainText("Di., 15.09.2026 · 50,0 % pünktlich · üblich 80,0 %");
    await expect(card).toContainText("Fernverkehr · 40,0 % pünktlich · üblich 60,0 %");
    await expect(card).toContainText("Regionalverkehr · 52,0 % pünktlich · üblich 82,0 %");
    // The state's own step, then Fern's and Regional's.
    for (const [i, name] of [
      "−30 %-Pkt. · viel schlechter",
      "−20 %-Pkt. · schlechter",
      "−30 %-Pkt. · viel schlechter",
    ].entries())
      await expect(card.getByRole("img").nth(i)).toHaveAccessibleName(name);
    // The map zooms to the state, past the overview.
    await expect(states(page)).toHaveCount(0);

    await card.getByRole("button", { name: "← Deutschland" }).click();
    await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}$`));
    await expect(germany(page)).toContainText("Deutschland");
    await expect(germany(page)).toContainText("78,9 % pünktlich");
    await expect(germany(page).getByRole("button")).toHaveCount(0);
    await expect(states(page)).toHaveCount(16);
  });

  test("a state picked by keyboard hands the focus to the back button, and the back button to the map", async ({
    page,
  }) => {
    await open(page);
    await state(page, "Nordrhein-Westfalen").focus();
    await page.keyboard.press("Enter");
    const back = page
      .getByRole("region", { name: "Nordrhein-Westfalen an diesem Tag" })
      .getByRole("button", { name: "← Deutschland" });
    await expect(back).toBeFocused();
    await expect(states(page)).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(germany(page)).toBeVisible();
    await expect(map(page).locator("canvas")).toBeFocused();
  });

  test("a click on the picked state zooms to it again", async ({ page }) => {
    await open(page, `tag=${DAY}&land=nw`);
    await expect(states(page)).toHaveCount(0);
    // Zoom out by hand until the cards are back, one eased step at a time.
    await expect
      .poll(async () => {
        await page.getByRole("button", { name: "Verkleinern" }).click();
        await page.waitForTimeout(600);
        return states(page).count();
      })
      .toBe(16);
    await state(page, "Nordrhein-Westfalen").click();
    await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}&land=nw$`));
    await expect(states(page)).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Nordrhein-Westfalen an diesem Tag" })
        .getByRole("button", { name: "← Deutschland" }),
    ).toBeFocused();
  });

  /** The map's zoom once two reads 600 ms apart agree. */
  async function settledZoom(page: Page) {
    let last = "";
    await expect
      .poll(async () => {
        const seen = last;
        last = (await map(page).getAttribute("data-zoom")) ?? "";
        await page.waitForTimeout(600);
        return last === seen;
      })
      .toBe(true);
    return Number(last);
  }

  /** Picks `name` and waits for the zoom to end: the map's zoom and visible bounds [w, s, e, n]. */
  async function pickAndFit(page: Page, name: string) {
    await open(page);
    // A late font swap or layout change refits Germany: read the start view once it stays put.
    await fontsReady(page);
    const start = await settledZoom(page);
    await state(page, name).click();
    await expect
      .poll(async () => Number(await map(page).getAttribute("data-zoom")))
      .toBeGreaterThan(start);
    // An ease that is taken over by the next one ends once on the way: wait for the last end.
    const zoom = await settledZoom(page);
    await expect(states(page)).toHaveCount(0);
    return {
      zoom,
      bounds: (await map(page).getAttribute("data-bounds"))!.split(",").map(Number),
    };
  }

  /** The bounding box [w, s, e, n] of a state's shape in the Natural Earth file. */
  async function shapeBox(page: Page, code: string) {
    const json = await (await page.request.get("/laender.geojson")).json();
    const shape = json.features.find(
      (f: { properties: { code: string } }) => f.properties.code === code,
    );
    const lons: number[] = [];
    const lats: number[] = [];
    shape.geometry.coordinates
      .flat(Infinity)
      .forEach((v: number, i: number) => (i % 2 ? lats : lons).push(v));
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }

  test("the zoom to a state keeps its whole shape in view, with the cards gone", async ({
    page,
  }) => {
    const { bounds } = await pickAndFit(page, "Bayern");
    const [w, s, e, n] = await shapeBox(page, "by");
    expect(bounds[0]).toBeLessThanOrEqual(w);
    expect(bounds[1]).toBeLessThanOrEqual(s);
    expect(bounds[2]).toBeGreaterThanOrEqual(e);
    expect(bounds[3]).toBeGreaterThanOrEqual(n);
    // At the state's fit the cards are gone.
    await expect(states(page)).toHaveCount(0);
  });

  test("the zoom to a small state stops at zoom 8", async ({ page }) => {
    const { zoom } = await pickAndFit(page, "Berlin");
    expect(zoom).toBeCloseTo(8, 3);
  });

  test("without the state shapes a click still zooms to the state's stations", async ({ page }) => {
    await page.route("**/laender.geojson", (route) => route.fulfill({ status: 404 }));
    await open(page);
    await fontsReady(page);
    const start = Number(await map(page).getAttribute("data-zoom"));
    await state(page, "Nordrhein-Westfalen").click();
    await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}&land=nw$`));
    await expect
      .poll(async () => Number(await map(page).getAttribute("data-zoom")))
      .toBeGreaterThan(start);
    await expect(states(page)).toHaveCount(0);
  });

  test("a state the day does not list shows the neutral card, and a click picks it", async ({
    page,
  }) => {
    await open(page);
    await state(page, "Berlin").click();
    await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}&land=be$`));
    const card = page.getByRole("region", { name: "Berlin an diesem Tag" });
    await expect(card).toContainText("Berlin · 0 große Bahnhöfe");
    await expect(card).toContainText("Di., 15.09.2026 · Keine Daten für diesen Tag");
    await expect(card.getByRole("img")).toHaveCount(0);
    await expect(card).not.toContainText("Fernverkehr");
    await expect(card.getByRole("button", { name: "← Deutschland" })).toBeVisible();
    await expect(states(page)).toHaveCount(0);
  });

  test("land in the URL opens the state's card and survives a change of day; an unknown one shows Germany", async ({
    page,
  }) => {
    await open(page, `tag=${DAY}&land=ni`);
    const card = page.getByRole("region", { name: "Niedersachsen an diesem Tag" });
    await expect(card).toContainText("2 große Bahnhöfe");
    await expect(card).not.toContainText("Fernverkehr");
    await expect(states(page)).toHaveCount(0);
    await page.getByLabel("Tag auswählen").fill("2026-09-29");
    await expect(page).toHaveURL(/\/lage\?tag=2026-09-29&land=ni$/);
    await expect(page.getByRole("region", { name: "Niedersachsen an diesem Tag" })).toContainText(
      "Di., 29.09.2026",
    );

    await page.goto(`/lage?tag=${DAY}&land=xx`);
    await expect(page).toHaveURL(new RegExp(`/lage\\?tag=${DAY}$`));
    await expect(germany(page)).toContainText("Deutschland");
    await expect(states(page)).toHaveCount(16);
  });

  test("today the state card keeps the stand of today", async ({ page }) => {
    await openToday(page, "land=nw");
    await expect(page.getByRole("region", { name: "Nordrhein-Westfalen heute" })).toContainText(
      "Heute, Stand 14:37 · bis 14:00",
    );
  });

  test("today a state without a reporting station has no data yet", async ({ page }) => {
    await openToday(page);
    await expect(state(page, "Berlin")).toHaveAccessibleName("Berlin · noch keine Daten für heute");
    await page.goto("/lage?land=be");
    await expect(page.getByRole("region", { name: "Berlin heute" })).toContainText(
      "Heute, Stand 14:37 · bis 14:00 · noch keine Daten für heute",
    );
  });

  test("the hover tooltip names the deviation, the value, the usual and the stations", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "needs a hover");
    await open(page);
    await state(page, "Nordrhein-Westfalen").hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Nordrhein-Westfalen · −30 %-Pkt. · 50,0 % pünktlich · üblich 80,0 % · 1 großer Bahnhof",
    );
    await state(page, "Niedersachsen").hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Niedersachsen · +1 %-Pkt. · 81,0 % pünktlich · üblich 80,0 % · 2 große Bahnhöfe",
    );
    // Without a comparison the tooltip has no deviation.
    await state(page, "Bayern").hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Bayern · 70,0 % pünktlich · üblich 80,0 % · 1 großer Bahnhof",
    );
  });

  test.describe("English", () => {
    test.use({ locale: "en-US" });

    test("the states, their counts and the back button read English", async ({ page }) => {
      await mockApi(page);
      await page.goto(`/lage?tag=${DAY}`);
      await expect(map(page)).toHaveAttribute("data-ready", "true");
      await expect(state(page, "North Rhine-Westphalia")).toHaveAccessibleName(
        "North Rhine-Westphalia · −30 pp · much worse",
      );
      // The deviation in English units and number format.
      const nw = state(page, "North Rhine-Westphalia");
      for (const [button, text] of [
        ["Punctuality", "−30 pp"],
        ["Typical delay", "+1 min"],
        ["Worst 10%", "±0 min"],
        ["Cancellations", "+0.5 pp"],
      ]) {
        await page.getByRole("button", { name: button, exact: true }).click();
        await expect(nw).toHaveText(text);
      }
      await expect(state(page, "Lower Saxony")).toBeVisible();
      await expect(state(page, "Bavaria")).toBeVisible();
      await state(page, "North Rhine-Westphalia").click();
      const card = page.getByRole("region", { name: "North Rhine-Westphalia on this day" });
      await expect(card).toContainText("1 large station");
      await page.goto(`/lage?tag=${DAY}&land=ni`);
      await expect(page.getByRole("region", { name: "Lower Saxony on this day" })).toContainText(
        "2 large stations",
      );
      await page.getByRole("button", { name: "← Germany" }).click();
      await expect(page.getByRole("region", { name: "Germany on this day" })).toBeVisible();
    });
  });
});

test.describe("stations are coloured by the class the API gives", () => {
  // The API's field of each metric button; its class is the fill, 1 to 5 on the r scale, none grey.
  const metrics = [
    ["Pünktlichkeit", "puenktlich"],
    ["Typische Verspätung", "median"],
    ["Schlechteste 10 %", "p90"],
    ["Ausfälle", "ausfallquote"],
  ] as const;
  const order = [1, 2, 3, 4, 5, null];
  const names = Object.keys(STATIONS) as (keyof typeof STATIONS)[];

  test("every class from 1 to 5 and none has its fill, for each metric", async ({
    page,
    isMobile,
  }) => {
    // One page load per station, to see it zoomed in.
    test.slow();
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
    for (const [i, name] of names.entries()) {
      const at = await focus(page, String(8100000 + i), isMobile);
      for (const [shift, [button]] of metrics.entries()) {
        await page.getByRole("button", { name: button, exact: true }).click();
        await expect(map(page)).toHaveAttribute("data-ready", "true");
        const cls = order[(i + shift) % order.length];
        const want = await token(page, cls ? `r${cls}` : "c3");
        await expect.poll(() => colourAt(page, at), `${button} ${name} ${cls}`).toBe(want);
      }
    }
  });

  test("a day without any normal is grey everywhere", async ({ page, isMobile }) => {
    await mockApi(page);
    for (const eva of ["8000207", "8000105"]) {
      const at = await focus(page, eva, isMobile, "tag=2026-04-04");
      const grey = await token(page, "c3");
      await expect.poll(() => colourAt(page, at)).toBe(grey);
    }
  });
});

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "needs a hover");

  test("the tooltip names the day's value, the normal and the class", async ({ page }) => {
    // Past the overview, where the dots take a hover: each station picked and zoomed to.
    await mockApi(page);
    const koeln = await focus(page, "8000207", false);
    await tipAt(page, koeln).toBe("Köln Hbf · 50 % · üblich 80 % · viel schlechter");
    const none = await focus(page, "8000700", false);
    await tipAt(page, none).toBe("Ohnevergleich · 70 % · kein Vergleich möglich");
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
      ).toHaveText("Today");
      await openLegend(page);
      const l = page.getByRole("region", { name: "Legend" });
      for (const text of ["much better", "as usual", "much worse", "no comparison possible"])
        await expect(l).toContainText(text);
      await expect(l).toContainText("Reference days: 12 × Tuesday from the 12 weeks before");
      const card = page.getByRole("region", { name: "Germany on this day" });
      await expect(card.getByRole("img").first()).toHaveAccessibleName("−4 pp · much worse");
      await expect(card).toContainText("Long-distance · 44.6% on time · usual 43.0%");
      await expect(card).toContainText("Regional · 76.9% on time · usual 79.0%");
    });
  });
});

/** The step blocks of a card: its own first, then Fern's and Regional's. */
const steps = (card: Locator) => card.getByRole("img");

test.describe("the Germany card", () => {
  test("shows the deviation on its step colour, the day's value and the normal for the metric", async ({
    page,
  }) => {
    await open(page);
    const card = germany(page);
    await expect(steps(card).first()).toHaveAccessibleName("−4 %-Pkt. · viel schlechter");
    await expect(steps(card).first()).toHaveText("−4 %-Pkt.");
    await expect.poll(() => fillOf(steps(card).first())).toBe(await token(page, "r5"));
    await expect(card).toContainText("Di., 15.09.2026 · 78,9 % pünktlich · üblich 83,3 %");
    await expect(card).not.toContainText("Datenlücke");
    await page.getByRole("button", { name: "Typische Verspätung" }).click();
    await expect(card).toContainText("Di., 15.09.2026 · typisch 1 min verspätet · üblich 1 min");
    await expect(steps(card).first()).toHaveAccessibleName("±0 min · wie üblich");
    await expect.poll(() => fillOf(steps(card).first())).toBe(await token(page, "r3"));
    await page.getByRole("button", { name: "Ausfälle", exact: true }).click();
    await expect(card).toContainText("5,9 % ausgefallen · üblich 4,2 %");
    await expect(steps(card).first()).toHaveText("+1,7 %-Pkt.");
  });

  test("has a Fern and a Regional line under the main line, each against its usual", async ({
    page,
  }) => {
    await open(page);
    const card = germany(page);
    await expect(card).toContainText("Fernverkehr · 44,6 % pünktlich · üblich 43,0 %");
    await expect(card).toContainText("Regionalverkehr · 76,9 % pünktlich · üblich 79,0 %");
    // Each line has its own step: Fern better, Regional worse than usual.
    await expect(steps(card).nth(1)).toHaveAccessibleName("+2 %-Pkt. · besser");
    await expect.poll(() => fillOf(steps(card).nth(1))).toBe(await token(page, "r2"));
    await expect(steps(card).nth(2)).toHaveAccessibleName("−2 %-Pkt. · schlechter");
    await expect.poll(() => fillOf(steps(card).nth(2))).toBe(await token(page, "r4"));
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

  test("has the colour and the name of each of the five steps", async ({ page }) => {
    let cls = 1;
    const day = (tag: string) => {
      const fixture = tageskarteFixture(tag);
      fixture.deutschland!.klasse.puenktlich = cls;
      return fixture;
    };
    await mockDay(page, day);
    for (const [i, name] of STEP_NAMES.entries()) {
      cls = i + 1;
      await page.goto(`/lage?tag=${DAY}`);
      const block = steps(germany(page)).first();
      await expect(block).toHaveAccessibleName(`−4 %-Pkt. · ${name}`);
      await expect.poll(() => fillOf(block)).toBe(await token(page, `r${cls}`));
    }
  });

  test("notes the hours missing from the data and has a grey block without a comparison", async ({
    page,
  }) => {
    await open(page, "tag=2026-03-14");
    await expect(germany(page)).toContainText("Datenlücke: 6 h fehlen");
    await expect(germany(page)).toContainText("Sa., 14.03.2026");
    const block = steps(germany(page)).first();
    await expect(block).toHaveAccessibleName("kein Vergleich möglich");
    await expect(block).toHaveText("–");
    await expect.poll(() => fillOf(block)).toBe(await token(page, "c3"));
  });

  test("shows an empty state when Germany has no values", async ({ page }) => {
    await open(page, "tag=2026-03-01");
    await expect(germany(page)).toContainText("Keine Daten für diesen Tag");
    await expect(germany(page)).not.toContainText("Fernverkehr");
    await expect(germany(page)).toContainText("Datenlücke: 24 h fehlen");
    await expect(germany(page).getByRole("img")).toHaveCount(0);
  });

  test("a day without enough reference days has a grey block and says why", async ({ page }) => {
    await open(page, "tag=2026-04-04");
    await expect(steps(germany(page)).first()).toHaveAccessibleName("kein Vergleich möglich");
    await expect.poll(() => fillOf(steps(germany(page)).first())).toBe(await token(page, "c3"));
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
  await page.clock.setSystemTime(NOW);
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

/**
 * Picks a station on today's page, which zooms to it past the overview where the dots take a
 * hover, and hovers it until the tooltip reads `text`.
 */
async function expectTooltip(page: Page, eva: string, text: string) {
  await tipAt(page, await focus(page, eva, false, "")).toBe(text);
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
    await openToday(page, "", "both");
    await expectTooltip(
      page,
      "8000207",
      "Köln Hbf · 50 % · üblich 80 % · viel schlechter · Stand 14:37 · bis 14:00",
    );
    await expectTooltip(
      page,
      "8000600",
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
    await openToday(page);
    await expectTooltip(page, "8000555", "Problemhausen · noch keine Daten für heute");
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

  test("without a today the Heute button is disabled and the days end at the last complete one", async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByLabel("Tag auswählen")).toHaveAttribute("max", "2026-09-30");
    await expect(page.getByRole("button", { name: "Heute", exact: true })).toBeDisabled();
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

  test("the chips scroll in one row with the other filters and all three are reachable", async ({
    page,
  }) => {
    await open(page);
    await fontsReady(page);
    await expect(chips(page).getByRole("button")).toHaveCount(3);
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

  for (const every of [false, true])
    test(`at 375 × 812 all 16 state cards fit without overlapping each other or the page's cards, and without sideways scroll${every ? ", with every state compared" : ""}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      if (every) {
        // Like a real day: every state has a value and a deviation (the widest, "−30").
        await page.clock.setSystemTime(NOW);
        await mockDay(page, (tag) => {
          const fixture = tageskarteFixture(tag);
          const nw = fixture.laender[0];
          fixture.laender = "bw by be bb hb hh he mv ni nw rp sl sn st sh th"
            .split(" ")
            .map((land) => ({ ...nw, land }));
          return fixture;
        });
        await page.goto(`/lage?tag=${DAY}`);
        await expect(map(page)).toHaveAttribute("data-ready", "true");
      } else await open(page);
      await fontsReady(page);
      await expect(states(page)).toHaveCount(16);
      type Box = { x: number; y: number; width: number; height: number };
      const apart = (a: Box, b: Box) =>
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      // The start view refits while the page's cards settle, so the state cards may still move.
      await expect
        .poll(async () => {
          const tiles = await Promise.all(
            (await states(page).all()).map(async (b) => (await b.boundingBox())!),
          );
          const cards = await Promise.all(
            [page.getByTestId("map-card"), germany(page), legend(page)].map(
              async (c) => (await c.boundingBox())!,
            ),
          );
          const clashes: Box[][] = [];
          for (const [i, a] of tiles.entries())
            for (const b of [...tiles.slice(i + 1), ...cards])
              if (!apart(a, b)) clashes.push([a, b]);
          return clashes;
        })
        .toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
});
