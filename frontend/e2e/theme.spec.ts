import { expect, test, type Page } from "@playwright/test";
import { karteFixture, mockApi } from "./fixtures";

const BG = { light: "#f5f6f8", dark: "#0f1216" };
const STYLES = "https://tiles.openfreemap.org/styles/";

const html = (page: Page) => page.locator("html");
const bg = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
const group = (page: Page) => page.getByRole("group", { name: "Darstellung" });
const pick = (page: Page, name: string) => group(page).getByRole("button", { name }).click();
/** The switch lives in the sidebar on desktop and on the Mehr page on mobile. */
const open = (page: Page, isMobile: boolean) => page.goto(isMobile ? "/mehr" : "/muster/heatmap");

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test.describe("dark system", () => {
  test.use({ colorScheme: "dark" });

  test("System is the default and follows the OS", async ({ page, isMobile }) => {
    await open(page, isMobile);
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    expect(await bg(page)).toBe(BG.dark);
    await expect(group(page).getByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("Hell wins over the OS and survives a reload", async ({ page, isMobile }) => {
    await open(page, isMobile);
    await pick(page, "Hell");
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    expect(await bg(page)).toBe(BG.light);
    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await expect(group(page).getByRole("button", { name: "Hell" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("System after a pick follows the OS again", async ({ page, isMobile }) => {
    await open(page, isMobile);
    await pick(page, "Hell");
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await pick(page, "System");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
  });
});

test.describe("light system", () => {
  test.use({ colorScheme: "light" });

  test("Dunkel wins over the OS and survives a reload", async ({ page, isMobile }) => {
    await open(page, isMobile);
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await pick(page, "Dunkel");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    expect(await bg(page)).toBe(BG.dark);
    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
  });

  test("a stored value that is not a theme falls back to System", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("gleisatlas-theme", "neon"));
    await page.goto("/muster/heatmap");
    await expect(html(page)).toHaveAttribute("data-theme", "light");
  });
});

test("text colours reach 4.5:1 on every surface in both themes", async ({ page }) => {
  await page.goto("/muster/heatmap");
  const ratios = await page.evaluate(() => {
    const lum = (hex: string) => {
      const c = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const out: Record<string, number> = {};
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      const css = getComputedStyle(document.documentElement);
      const token = (name: string) => css.getPropertyValue(`--${name}`).trim();
      for (const fg of ["text", "text-2", "text-3"])
        for (const back of ["bg", "surface", "surface-2"]) {
          const [hi, lo] = [lum(token(fg)), lum(token(back))].sort((a, b) => b - a);
          out[`${theme} ${fg} on ${back}`] = (hi + 0.05) / (lo + 0.05);
        }
    }
    return out;
  });
  expect(Object.keys(ratios)).toHaveLength(18);
  for (const [pair, ratio] of Object.entries(ratios))
    expect(ratio, pair).toBeGreaterThanOrEqual(4.5);
});

test.describe("native select lists", () => {
  test.use({ colorScheme: "dark" });

  // The popup of a native select paints its options with their own colours, so each option needs an
  // opaque background and a text colour that contrast in the current theme.
  test("the options of every select are readable in Dunkel", async ({ page }) => {
    await page.goto("/muster/heatmap");
    // The two month selects fill once the data status has loaded.
    await expect(page.locator("select")).toHaveCount(3);
    await expect(page.locator("select").first().locator("option")).not.toHaveCount(0);
    const ratios = await page.evaluate(() => {
      const channels = (css: string) => css.match(/[\d.]+/g)!.map(Number);
      const lum = (rgb: number[]) => {
        const [r, g, b] = rgb
          .slice(0, 3)
          .map((v) => v / 255)
          .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return Array.from(document.querySelectorAll("select")).flatMap((select) =>
        Array.from(select.options, (option) => {
          const style = getComputedStyle(option);
          const back = channels(style.backgroundColor);
          const [hi, lo] = [lum(channels(style.color)), lum(back)].sort((a, b) => b - a);
          return { opaque: back.length < 4 || back[3] === 1, ratio: (hi + 0.05) / (lo + 0.05) };
        }),
      );
    });
    expect(ratios.length).toBeGreaterThan(3);
    for (const { opaque, ratio } of ratios) {
      expect(opaque).toBe(true);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });
});

test.describe("map", () => {
  test.use({ colorScheme: "dark" });

  /** The rendered pixels (r, g, b) in a square of `reach` around a station, read from a screenshot with the overlays hidden. */
  async function stationPixels(
    page: Page,
    lon: number,
    lat: number,
    isMobile: boolean,
    reach: number,
  ) {
    const box = (await page.getByTestId("map").boundingBox())!;
    // Measured before it is hidden: a hidden element has no box.
    const card = (await page.getByTestId("map-card").boundingBox())!;
    await page.addStyleTag({ content: "main > div > :not(:first-child) { visibility: hidden }" });
    const mercator = (lo: number, la: number) => ({
      x: (lo + 180) / 360,
      y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360)) / (2 * Math.PI),
    });
    // The initial view fits Germany into the map, minus the padding set in MapPage; on desktop the
    // top padding is the filter card's bottom edge plus 12 px.
    const { top, bottom, left, right } = isMobile
      ? { top: 140, bottom: 40, left: 8, right: 8 }
      : { top: card.y + card.height + 12 - box.y, bottom: 24, left: 24, right: 24 };
    const sw = mercator(5.9, 47.3);
    const ne = mercator(15.0, 55.05);
    const w = box.width - left - right;
    const h = box.height - top - bottom;
    const scale = Math.min(w / (ne.x - sw.x), h / (sw.y - ne.y));
    const p = mercator(lon, lat);
    const x = Math.round(box.x + left + w / 2 + (p.x - (sw.x + ne.x) / 2) * scale);
    const y = Math.round(box.y + top + h / 2 + (p.y - (sw.y + ne.y) / 2) * scale);
    const png = (await page.screenshot({ scale: "css" })).toString("base64");
    return page.evaluate(
      async ([data, px, py, d]) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${data}`)).blob(),
        );
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        const side = 2 * Number(d) + 1;
        const rgba = ctx.getImageData(Number(px) - Number(d), Number(py) - Number(d), side, side);
        return Array.from({ length: side * side }, (_, i) =>
          Array.from(rgba.data.slice(4 * i, 4 * i + 3)),
        );
      },
      [png, x, y, reach] as const,
    );
  }

  /** Colour of the rendered pixel at a station. */
  async function stationColour(page: Page, lon: number, lat: number, isMobile: boolean) {
    const [[r, g, b]] = await stationPixels(page, lon, lat, isMobile, 0);
    return `rgb(${r}, ${g}, ${b})`;
  }

  const token = (page: Page, name: string) =>
    page.evaluate((n) => {
      const hex = getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim();
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return `rgb(${r}, ${g}, ${b})`;
    }, name);

  test("the base map and the stations follow the theme", async ({ page, isMobile }) => {
    const styles: string[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith(STYLES)) styles.push(r.url());
    });
    await page.goto("/karte");
    await expect(page.getByTestId("map")).toHaveAttribute("data-ready", "true");
    expect(styles).toEqual([`${STYLES}dark`]);
    // Frankfurt (93 % punctual) is the best class.
    const frankfurt = [8.663, 50.107] as const;
    await expect
      .poll(
        async () =>
          (await stationColour(page, ...frankfurt, isMobile)) === (await token(page, "r1")),
      )
      .toBe(true);
    const darkFill = await token(page, "r1");

    await page.emulateMedia({ colorScheme: "light" });
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await expect(page.getByTestId("map")).toHaveAttribute("data-ready", "true");
    expect(styles).toEqual([`${STYLES}dark`, `${STYLES}positron`]);
    const lightFill = await token(page, "r1");
    expect(lightFill).not.toBe(darkFill);
    await expect
      .poll(async () => (await stationColour(page, ...frankfurt, isMobile)) === lightFill)
      .toBe(true);
  });

  test("the open map attribution uses the surface and text tokens", async ({ page }) => {
    await page.goto("/karte");
    await expect(page.getByTestId("map")).toHaveAttribute("data-ready", "true");
    const attribution = page.locator(".maplibregl-ctrl-attrib");
    // Wide maps open it by default; on a phone the toggle opens it.
    if (!(await attribution.evaluate((el) => el.classList.contains("maplibregl-compact-show"))))
      await page.locator("summary.maplibregl-ctrl-attrib-button").click();
    await expect(attribution).toHaveClass(/maplibregl-compact-show/);
    const style = (selector: string, property: "backgroundColor" | "color") =>
      page
        .locator(selector)
        .first()
        .evaluate((el, p) => getComputedStyle(el)[p], property);
    expect(await style(".maplibregl-ctrl-attrib", "backgroundColor")).toBe(
      await token(page, "surface"),
    );
    expect(await style(".maplibregl-ctrl-attrib", "color")).toBe(await token(page, "text"));
    expect(await style(".maplibregl-ctrl-attrib a", "color")).toBe(await token(page, "text-2"));
  });

  test("the zoom buttons take the surface token and invert their icons in the dark theme", async ({
    page,
  }) => {
    await page.goto("/karte");
    await expect(page.getByTestId("map")).toHaveAttribute("data-ready", "true");
    const button = page.locator(".maplibregl-ctrl-zoom-in");
    const icon = button.locator(".maplibregl-ctrl-icon");
    await expect(button).toHaveCSS("background-color", await token(page, "surface"));
    await expect(icon).toHaveCSS("filter", "invert(1)");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await expect(button).toHaveCSS("background-color", await token(page, "surface"));
    await expect(icon).toHaveCSS("filter", "none");
  });

  test("stations with little data are drawn paler, in both themes", async ({ page, isMobile }) => {
    // Three stations of the same class (93 %): plenty of stops, 30 stops ("~"), 9 stops (no value).
    const karte = karteFixture();
    const [, normal, few, some] = karte.stationen;
    Object.assign(some, { n: 30, puenktlich: 0.93, ausfallquote: 0 });
    Object.assign(few, { puenktlich: 0.93 });
    await mockApi(page, undefined, () => karte);
    await page.goto("/karte");
    const map = page.getByTestId("map");
    await expect(map).toHaveAttribute("data-ready", "true");
    // The strongest pixel's distance from the base map, which the patch's corner shows.
    const contrast = async (s: { lon: number; lat: number }) => {
      const px = await stationPixels(page, s.lon, s.lat, isMobile, 10);
      return Math.max(...px.map((p) => p.reduce((sum, v, i) => sum + Math.abs(v - px[0][i]), 0)));
    };
    const measure = async () => {
      const [a, b, c] = [await contrast(normal), await contrast(some), await contrast(few)];
      return a > 100 && b <= 0.7 * a && c < b && c > 10;
    };
    await expect.poll(measure).toBe(true);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(map).toHaveAttribute("data-ready", "true");
    await expect.poll(measure).toBe(true);
  });

  test("a station picked while the new base style loads does not crash the page", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const map = page.getByTestId("map");
    await page.goto("/karte");
    await expect(map).toHaveAttribute("data-ready", "true");
    // Hold the light style back, so the switch stays in flight.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`${STYLES}positron`, async (route) => {
      await held;
      await route.fallback();
    });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(map).toHaveAttribute("data-ready", "false");
    await page.evaluate(() => {
      history.pushState(null, "", "/karte?bhf=8000207");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByRole("complementary", { name: "Köln Hbf" })).toBeVisible();
    release();
    await expect(map).toHaveAttribute("data-ready", "true");
    await expect(page.getByRole("complementary", { name: "Köln Hbf" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("the switch on Mehr has 44 px hit areas", async ({ page }) => {
    await page.goto("/mehr");
    for (const name of ["System", "Hell", "Dunkel"]) {
      const c = group(page).getByRole("button", { name });
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
