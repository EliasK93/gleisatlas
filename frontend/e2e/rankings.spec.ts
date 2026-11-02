import { expect, test, type Locator, type Page } from "@playwright/test";
import { emptyRangliste, mockApi, queryOf, rankingFixture } from "./fixtures";

// Scale tokens from theme.css as the browser reports them.
const R1 = "rgb(33, 102, 172)";
const R5 = "rgb(178, 24, 43)";
const CANCEL = "rgb(93, 102, 117)";

const column = (page: Page, name: string) => page.getByRole("region", { name });
const WORST = "Am unzuverlässigsten";
const BEST = "Am zuverlässigsten";
const rankingRequests = (requests: URL[]) => requests.filter((u) => u.pathname === "/rankings");
/** The query of the latest /rankings request. */
const lastQuery = (requests: URL[]) => queryOf(rankingRequests(requests).at(-1));
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
    for (const name of ["Linien", "1.000", "Schlechteste 10 %"])
      await expect(pressed(page, name)).toBeVisible();
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

  test("line rows show the type badge and link to the time series, keeping the category", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?typ=linien&g=fern&k=median&von=2025-11");
    const worst = column(page, WORST);
    await expect(
      worst.getByRole("listitem").first().getByText("RE", { exact: true }),
    ).toBeVisible();
    const link = worst.getByRole("link", { name: /RE 1/ }).first();
    await expect(link).toHaveAttribute(
      "href",
      "/muster/zeitverlauf?g=fern&linie=RE+1%3A8000207&k=median",
    );
    await link.click();
    await expect(page).toHaveURL(/\/muster\/zeitverlauf\?g=fern&linie=RE\+1%3A8000207&k=median$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Zeitverlauf");
  });

  test("a line row passes every metric on to the time series unchanged", async ({ page }) => {
    await mockApi(page);
    await page.goto("/muster/rankings?typ=linien&k=p90");
    const link = column(page, WORST).getByRole("link", { name: /RE 1/ }).first();
    await expect(link).toHaveAttribute("href", "/muster/zeitverlauf?linie=RE+1%3A8000207&k=p90");
    await page.goto("/muster/rankings?typ=linien&k=ausfall");
    await expect(link).toHaveAttribute(
      "href",
      "/muster/zeitverlauf?linie=RE+1%3A8000207&k=ausfall",
    );
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
