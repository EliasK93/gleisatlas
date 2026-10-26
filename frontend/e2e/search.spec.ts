import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./fixtures";

// The global field is named "Bahnhofssuche"; the filter chip's field keeps "Bahnhof suchen".
const search = (page: Page) => page.getByRole("combobox", { name: "Bahnhofssuche" });
// Only the station results; the Gattung select has options of its own.
const options = (page: Page) => page.getByRole("listbox", { name: "Bahnhof" }).getByRole("option");

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
  expect(urls.some((u) => u.pathname === "/stationen" && u.searchParams.get("limit") === "8")).toBe(
    true,
  );
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
  await expect(page.getByText("Kein Bahnhof gefunden")).toBeVisible();
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
    (url) => url.pathname === "/stationen" && url.searchParams.get("q") === "hamburg",
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
  await expect(page).toHaveURL(/\/bahnhof\/8002549$/);
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
    await expect(search(page)).toHaveAttribute("placeholder", "Bahnhof suchen …");
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

test.describe("mobile", () => {
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

for (const [locale, placeholder] of [
  ["de-DE", "Bahnhof suchen …"],
  ["en-US", "Search stations …"],
] as const)
  test.describe(`the global field in ${locale}`, () => {
    test.use({ locale });

    const field = (page: Page) => page.locator("input[data-global-search]:visible");

    test("the placeholder fits the field and the magnifier is drawn", async ({ page }) => {
      await page.goto("/muster/heatmap");
      await expect(field(page)).toHaveAttribute("placeholder", placeholder);
      const [text, room] = await field(page).evaluate((input) => {
        const style = getComputedStyle(input);
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = style.font;
        return [
          ctx.measureText((input as HTMLInputElement).placeholder).width,
          input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        ];
      });
      expect(text).toBeLessThanOrEqual(room);
      // The icon sits behind the field's own background unless it is stacked above it.
      const icon = field(page).locator("xpath=../..").locator("svg");
      const clip = (await icon.boundingBox())!;
      const shot = () => page.screenshot({ clip });
      const shown = await shot();
      await icon.evaluate((el) => (el.style.visibility = "hidden"));
      expect(shown.equals(await shot())).toBe(false);
    });
  });
