import { expect, test, type Page } from "@playwright/test";
import { fontsReady, mockApi, STATIONS } from "./fixtures";

// The global field is named "Suche"; the filter chip's field keeps "Bahnhof suchen".
const search = (page: Page) => page.getByRole("combobox", { name: "Suche", exact: true });
const results = (page: Page) => page.getByRole("listbox", { name: "Suche", exact: true });
// Only the search results; the Gattung select has options of its own.
const options = (page: Page) => results(page).getByRole("option");
const group = (page: Page, name: string) => results(page).getByRole("group", { name });

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test("typing, arrow keys and Enter open the station and keep the filters", async ({ page }) => {
  const urls: URL[] = [];
  page.on("request", (r) => urls.push(new URL(r.url())));
  await page.goto("/karte?g=fern&bhf=8000207&von=2026-09&bis=2026-09&k=p90");
  const field = search(page);
  await field.fill("hbf");
  await expect(options(page)).toHaveCount(3);
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await field.press("ArrowDown");
  await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await expect(options(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await field.press("ArrowUp");
  await field.press("Enter");
  // Frankfurt, with g, von, bis and k kept and bhf dropped.
  await expect(page).toHaveURL(/\/bahnhof\/8000105\?g=fern&von=2026-09&bis=2026-09&k=p90$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Frankfurt (Main) Hbf");
  await expect(field).toHaveValue("");
  const asked = urls.filter((u) => u.pathname === "/suche");
  expect(asked.some((u) => u.searchParams.get("q") === "hbf")).toBe(true);
  expect(asked.every((u) => u.searchParams.get("limit") === "8")).toBe(true);
  expect(urls.some((u) => u.pathname === "/stationen")).toBe(false);
});

test("a place query shows the stations and no line group when the API sends no lines", async ({
  page,
}) => {
  await page.goto("/muster/heatmap");
  await search(page).fill("köln");
  await expect(group(page, "Bahnhöfe").getByRole("option")).toHaveCount(1);
  await expect(group(page, "Linien")).toHaveCount(0);
  await expect(results(page).getByText("Linien")).toHaveCount(0);
});

test("the API's order decides which group comes first", async ({ page }) => {
  // Both groups in one answer, the lines leading.
  await page.route(
    (url) => url.pathname === "/suche",
    (route) =>
      route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: {
          bahnhoefe: [STATIONS[0]],
          linien: [
            {
              linie: "S6:08000082",
              label: "S6 Essen Hbf – Köln-Worringen",
              typ: "S",
              zug: false,
              richtung: null,
              ziel: null,
            },
          ],
          zuerst: "linien",
        },
      }),
  );
  await page.goto("/muster/heatmap");
  await search(page).fill("s6 köln");
  const groups = results(page).getByRole("group");
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toHaveAccessibleName("Linien");
  await expect(groups.nth(1)).toHaveAccessibleName("Bahnhöfe");
  await expect(options(page).first()).toContainText("S6 Essen Hbf – Köln-Worringen");
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
});

test("a line name lists the exact line first, then the prefix hits, with no station group", async ({
  page,
}) => {
  await page.goto("/muster/heatmap");
  // Spaces and case do not matter.
  await search(page).fill("S 6");
  await expect(group(page, "Bahnhöfe")).toHaveCount(0);
  const lines = group(page, "Linien").getByRole("option");
  await expect(lines).toHaveCount(2);
  await expect(lines.first()).toContainText("S6 Essen Hbf – Köln-Worringen");
  await expect(lines.nth(1)).toContainText("S60 Leonberg – Stuttgart Schwabstr.");
});

test("a line option shows its type badge, its label and the matched direction", async ({
  page,
}) => {
  await page.goto("/muster/heatmap");
  await search(page).fill("re57 dortmund");
  const option = group(page, "Linien").getByRole("option");
  await expect(option).toHaveCount(1);
  await expect(option.getByText("RE", { exact: true })).toBeVisible();
  await expect(option).toContainText("RE57 Dortmund Hbf – Warburg (Westf)");
  await expect(option).toContainText("Richtung Dortmund Hbf");
  // Without a station part there is no direction.
  await search(page).fill("re57");
  await expect(option).toContainText("RE57 Dortmund Hbf – Warburg (Westf)");
  await expect(option).not.toContainText("Richtung");
});

test("the arrow keys run across both groups in their shown order", async ({ page }) => {
  await page.goto("/muster/heatmap");
  const field = search(page);
  // Three stations contain an s, and S6 and S60 start with it; no exact name, so stations lead.
  await field.fill("s");
  await expect(options(page)).toHaveCount(5);
  await expect(results(page).getByRole("group").first()).toHaveAccessibleName("Bahnhöfe");
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await expect(options(page).nth(3)).toHaveAttribute("aria-selected", "true");
  await expect(options(page).nth(3)).toContainText("S6 Essen Hbf");
  await expect(field).toHaveAttribute(
    "aria-activedescendant",
    (await options(page).nth(3).getAttribute("id"))!,
  );
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await expect(options(page).nth(4)).toHaveAttribute("aria-selected", "true");
  await field.press("ArrowUp");
  await field.press("Enter");
  await expect(page).toHaveURL(/\/linie\/S6%3A08000082$/);
});

test("a line pick opens the line page with metric and period kept and the direction", async ({
  page,
}) => {
  await page.goto("/karte?g=fern&bhf=8000207&von=2026-09&bis=2026-09&k=p90");
  await search(page).fill("re57 dortmund");
  await search(page).press("Enter");
  await expect(page).toHaveURL(
    /\/linie\/RE57%3A08000080\?von=2026-09&bis=2026-09&richtung=2&k=p90$/,
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "RE57 Dortmund Hbf – Warburg (Westf)",
  );
  await expect(search(page)).toHaveValue("");
});

test("a line toward its last station opens without a direction key", async ({ page }) => {
  await page.goto("/muster/heatmap");
  await search(page).fill("re57 warburg");
  await expect(options(page)).toContainText("Richtung Warburg (Westf)");
  await options(page).click();
  await expect(page).toHaveURL(/\/linie\/RE57%3A08000080$/);
});

test("an option shows name, state, EVA and number of stops", async ({ page }) => {
  await page.goto("/muster/heatmap");
  await search(page).fill("köln");
  const option = page.getByRole("option", { name: /Köln Hbf/ });
  await expect(option).toContainText("Nordrhein-Westfalen · EVA 8000207 · 90.000 Halte");
  await option.click();
  await expect(page).toHaveURL(/\/bahnhof\/8000207$/);
});

test("a missing state is left out, without a stray separator", async ({ page }) => {
  await page.goto("/muster/heatmap");
  await search(page).fill("kleinstadt");
  const option = page.getByRole("option", { name: /Kleinstadt/ });
  await expect(option).toContainText("EVA 8000999 · 9 Halte");
  await expect(option).not.toContainText("· EVA");
  await expect(option).not.toContainText("Einträge mit diesem Namen");
});

test("the same name twice gets a hint, a unique name does not", async ({ page }) => {
  await page.goto("/muster/heatmap");
  await search(page).fill("neustadt");
  await expect(options(page)).toHaveCount(2);
  for (const option of await options(page).all())
    await expect(option).toContainText("2 Einträge mit diesem Namen");
  await search(page).fill("köln");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page)).not.toContainText("Einträge mit diesem Namen");
});

test("Escape clears the field; no match says so", async ({ page }) => {
  await page.goto("/muster/heatmap");
  const field = search(page);
  await field.fill("xyz");
  await expect(page.getByText("Kein Bahnhof und keine Linie gefunden")).toBeVisible();
  await field.fill("köln");
  await expect(options(page)).toHaveCount(1);
  await field.press("Escape");
  await expect(field).toHaveValue("");
  await expect(options(page)).toHaveCount(0);
});

test("Enter while a new term loads does not open a hit of the old term", async ({ page }) => {
  await page.goto("/karte");
  const field = search(page);
  await field.fill("köln");
  await expect(options(page)).toHaveCount(1);
  // The answer for the next term is held back, so the old hits are still on screen.
  await page.route(
    (url) => url.pathname === "/suche" && url.searchParams.get("q") === "hamburg",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fallback();
    },
  );
  await field.fill("hamburg");
  await field.press("Enter");
  await expect(options(page).first()).toContainText("Hamburg Hbf");
  await expect(page).toHaveURL(/\/karte$/);
  await field.press("Enter");
  await expect(page).toHaveURL(/\/bahnhof\/08002549$/);
});

test("Ctrl+K and Cmd+K are taken over by the page", async ({ page }) => {
  await page.goto("/muster/heatmap");
  const prevented = await page.evaluate(() =>
    [{ ctrlKey: true }, { metaKey: true }, {}].map((mod) => {
      const e = new KeyboardEvent("keydown", { key: "k", cancelable: true, ...mod });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  );
  expect(prevented).toEqual([true, true, false]);
});

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("Ctrl+K focuses the sidebar field, which shows its shortcut", async ({ page }) => {
    await page.goto("/muster/heatmap");
    await expect(search(page)).toHaveCount(1);
    await expect(search(page)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
    await expect(page.locator("kbd:visible")).toHaveText("Strg K");
    await expect(search(page)).toHaveAttribute("placeholder", "Bahnhof, Linie …");
    await expect(search(page)).not.toBeFocused();
    await page.keyboard.press("Control+k");
    await expect(search(page)).toBeFocused();
  });

  test("the field sits in the sidebar under the logo, in the viewport", async ({ page }) => {
    await page.goto("/karte");
    const field = (await search(page).boundingBox())!;
    expect(field.x + field.width).toBeLessThanOrEqual(248);
    expect(field.y).toBeGreaterThan(40);
  });
});

test.describe("mobile", { tag: "@phone" }, () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("the top bar holds the only field; Ctrl+K focuses it; a tap opens a station", async ({
    page,
  }) => {
    await page.goto("/muster/heatmap?g=fern");
    await expect(search(page)).toHaveCount(1);
    const field = (await search(page).boundingBox())!;
    const bar = (await page.getByRole("banner").boundingBox())!;
    expect(field.y).toBeGreaterThanOrEqual(bar.y);
    expect(field.y + field.height).toBeLessThanOrEqual(bar.y + bar.height);
    // A tap 21 px above and below the field's centre still reaches it (through its label).
    const reaches = await search(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const label = el.closest("label")!;
      return [-21, 21].every((dy) => label.contains(document.elementFromPoint(x, y + dy)));
    });
    expect(reaches).toBe(true);
    await expect(page.locator("kbd:visible")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await expect(search(page)).toBeFocused();
    await search(page).fill("köln");
    await page.getByRole("option", { name: /Köln Hbf/ }).tap();
    await expect(page).toHaveURL(/\/bahnhof\/8000207\?g=fern$/);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(fits).toBe(true);
  });

  test("a tap on a line opens its page; the options are 44 px high", async ({ page }) => {
    await page.goto("/muster/heatmap?k=median");
    await search(page).fill("s");
    for (const option of await options(page).all())
      expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("option", { name: /S60 Leonberg/ }).tap();
    await expect(page).toHaveURL(/\/linie\/S60%3A08000096\?k=median$/);
  });

  test("the result list opens over the map", async ({ page }) => {
    await page.goto("/karte");
    await search(page).fill("köln");
    const option = page.getByRole("option", { name: /Köln Hbf/ });
    await expect(option).toBeVisible();
    const box = (await option.boundingBox())!;
    const top = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest("[role=option]") !== null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(top).toBe(true);
  });
});

test.describe("English", () => {
  test.use({ locale: "en-US" });

  test("a line option names its direction like the line page's toggle", async ({ page }) => {
    await page.goto("/muster/heatmap");
    await page.getByRole("combobox", { name: "Search", exact: true }).fill("re57 dortmund");
    await expect(
      page.getByRole("listbox", { name: "Search", exact: true }).getByRole("option"),
    ).toContainText("Direction Dortmund Hbf");
  });
});

for (const [locale, placeholder] of [
  ["de-DE", "Bahnhof, Linie …"],
  ["en-US", "Station or line …"],
] as const)
  test.describe(`the global field in ${locale}`, () => {
    test.use({ locale });

    const field = (page: Page) => page.locator("input[data-global-search]:visible");

    test(
      "the placeholder fits the field and the magnifier is drawn",
      { tag: "@phone" },
      async ({ page }) => {
        await page.goto("/muster/heatmap");
        await expect(field(page)).toHaveAttribute("placeholder", placeholder);
        // The mobile top bar shifts the icon when Inter swaps in, between the clip and the shot.
        await fontsReady(page);
        const [text, room] = await field(page).evaluate((input) => {
          const style = getComputedStyle(input);
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = style.font;
          const box = input.getBoundingClientRect();
          const start = box.left + input.clientLeft + parseFloat(style.paddingLeft);
          let end =
            box.left + input.clientLeft + input.clientWidth - parseFloat(style.paddingRight);
          // The shortcut hint sits over the field's right edge: the text must end before it.
          const kbd = input.closest("label")?.parentElement?.querySelector("kbd");
          if (kbd?.checkVisibility()) end = Math.min(end, kbd.getBoundingClientRect().left);
          return [ctx.measureText((input as HTMLInputElement).placeholder).width, end - start];
        });
        expect(text).toBeLessThanOrEqual(room);
        // The icon sits behind the field's own background unless it is stacked above it.
        const icon = field(page).locator("xpath=../..").locator("svg");
        const clip = (await icon.boundingBox())!;
        const shot = () => page.screenshot({ clip });
        const shown = await shot();
        await icon.evaluate((el) => (el.style.visibility = "hidden"));
        expect(shown.equals(await shot())).toBe(false);
      },
    );
  });
