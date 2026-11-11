import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./fixtures";

const html = (page: Page) => page.locator("html");
const group = (page: Page, name: string) => page.getByRole("group", { name });
/** The switch lives in the sidebar on desktop and on the Mehr page on mobile. */
const open = (page: Page, isMobile: boolean) => page.goto(isMobile ? "/mehr" : "/muster/heatmap");

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test.describe("English browser", () => {
  test.use({ locale: "en-US" });

  test("the first visit is English", async ({ page, isMobile }) => {
    await page.goto("/muster/heatmap");
    await expect(html(page)).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "Weekday × hour", level: 1 })).toBeVisible();
    await expect(page.getByText("n = 203,000 stops")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await open(page, isMobile);
    await expect(page.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/deed.en",
    );
    await expect(group(page, "Language")).toBeVisible();
  });

  test("Deutsch reloads into German and the pick is remembered", async ({ page, isMobile }) => {
    await open(page, isMobile);
    await group(page, "Language").getByRole("button", { name: "Deutsch" }).click();
    await expect(html(page)).toHaveAttribute("lang", "de");
    await expect(group(page, "Sprache")).toBeVisible();
    await expect(page.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/deed.de",
    );
    await page.reload();
    await expect(html(page)).toHaveAttribute("lang", "de");
    await expect(group(page, "Sprache").getByRole("button", { name: "Deutsch" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("the filters survive the switch", async ({ page, isMobile }) => {
    await page.goto(isMobile ? "/mehr?g=fern" : "/muster/heatmap?g=fern");
    await group(page, "Language").getByRole("button", { name: "Deutsch" }).click();
    await expect(html(page)).toHaveAttribute("lang", "de");
    expect(new URL(page.url()).searchParams.get("g")).toBe("fern");
  });

  test("short months carry an apostrophe, so they cannot read as a day", async ({ page }) => {
    await page.goto("/muster/zeitverlauf");
    await expect(
      page.getByText("Until Oct '25 only about 130 large stations, from Nov '25 all of them."),
    ).toBeVisible();
  });

  test("the station page and a search hit name the state in English", async ({ page }) => {
    await page.goto("/bahnhof/8000207");
    await expect(page.getByRole("main")).toContainText("EVA 8000207 · North Rhine-Westphalia");
    await page.getByRole("combobox").first().fill("köln");
    await expect(page.getByRole("option", { name: /Köln Hbf/ })).toContainText(
      "North Rhine-Westphalia · EVA 8000207",
    );
  });

  test("a stored value that is not a language falls back to the browser", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("gleisatlas-lang", "klingon"));
    await page.goto("/muster/heatmap");
    await expect(html(page)).toHaveAttribute("lang", "en");
  });
});

test.describe("German browser", () => {
  test.use({ locale: "de-DE" });

  test("the first visit is German", async ({ page }) => {
    await page.goto("/muster/heatmap");
    await expect(html(page)).toHaveAttribute("lang", "de");
    await expect(
      page.getByRole("heading", { name: "Wochentag × Uhrzeit", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("n = 203.000 Halte")).toBeVisible();
  });

  test("English wins over the browser and survives a reload", async ({ page, isMobile }) => {
    await open(page, isMobile);
    await group(page, "Sprache").getByRole("button", { name: "English" }).click();
    await expect(html(page)).toHaveAttribute("lang", "en");
    await page.reload();
    await expect(html(page)).toHaveAttribute("lang", "en");
    await expect(page.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/deed.en",
    );
  });
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("the switch on Mehr has 44 px hit areas", async ({ page }) => {
    await page.goto("/mehr");
    for (const name of ["Deutsch", "English"]) {
      const c = group(page, "Sprache").getByRole("button", { name });
      // A tap 21 px above and below the centre still lands on the control.
      const ok = await c.evaluate((el) => {
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return [-21, 21].every((dy) => el.contains(document.elementFromPoint(x, y + dy)));
      });
      expect(ok, name).toBe(true);
    }
  });
});
