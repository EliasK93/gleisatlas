import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

const UNBUILT = ["Verbindung planen", "Umstieg prüfen", "So liest man die Zahlen"];

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test("the shell shows title, disclaimer and attribution", async ({ page }) => {
  await page.goto("/muster/heatmap");
  await expect(page.getByRole("banner").getByRole("heading", { name: "Gleisatlas" })).toBeVisible();
  await expect(page).toHaveTitle("Wochentag × Uhrzeit · Gleisatlas");
  const footer = page.getByRole("contentinfo");
  await expect(footer).toContainText("Historische Statistik, keine Prognose oder Garantie");
  await expect(footer).toContainText("Kein Angebot der Deutschen Bahn");
  await expect(footer).toContainText(
    "Daten: Deutsche Bahn (via piebro/deutsche-bahn-data und DB Timetables API), CC BY 4.0, aggregiert",
  );
  await expect(footer.getByRole("link", { name: "piebro/deutsche-bahn-data" })).toHaveAttribute(
    "href",
    "https://huggingface.co/datasets/piebro/deutsche-bahn-data",
  );
  const licence = footer.getByRole("link", { name: "CC BY 4.0" });
  await expect(licence).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0/deed.de",
  );
  await expect(licence).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("main")).toBeAttached();
});

test("/ redirects to the map, unknown paths too", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/karte$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Karte");
  await page.goto("/gibt-es-nicht");
  await expect(page).toHaveURL(/\/karte$/);
});

test("/ and the logo link keep the query string", async ({ page }) => {
  await page.goto("/?g=fern");
  await expect(page).toHaveURL(/\/karte\?g=fern$/);
  await expect(page.getByRole("banner").getByRole("link", { name: "Gleisatlas" })).toHaveAttribute(
    "href",
    "/?g=fern",
  );
});

test(
  "the logo is the wordmark on desktop and the mark alone on mobile",
  { tag: "@phone" },
  async ({ page, request, isMobile }) => {
    await page.goto("/muster/heatmap");
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
    const logo = page.getByRole("banner").getByRole("img", { name: "Gleisatlas" });
    await expect(logo).toBeVisible();
    const shown = isMobile ? "/favicon.svg" : "/logo.svg";
    await expect
      .poll(() => logo.evaluate((img: HTMLImageElement) => img.currentSrc))
      .toMatch(shown);
    for (const file of ["/favicon.svg", "/logo.svg"])
      expect((await request.get(file)).headers()["content-type"]).toContain("image/svg+xml");
  },
);

test("a filter change after another key keeps the heatmap page mounted", async ({ page }) => {
  await page.goto("/muster/heatmap?k=median");
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toBeVisible();
  await title.evaluate((el) => (el.dataset.mark = "kept"));
  await page.getByLabel("Gattung:").selectOption("fern");
  await expect(page).toHaveURL(/\/muster\/heatmap\?g=fern&k=median$/);
  await expect(title).toHaveAttribute("data-mark", "kept");
});

test("the Live-Lage link from a line page with a Bildfahrplan day opens the newest day", async ({
  page,
}) => {
  await page.goto("/linie/RE57%3A08000080?tag=2026-09-20&k=median");
  await expect(page).toHaveURL(/tag=2026-09-20/);
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByRole("link", { name: "Live-Lage" })).toHaveAttribute(
    "href",
    "/lage?k=median",
  );
  // On Live-Lage itself the day stays.
  await page.goto("/lage?tag=2026-09-20&k=median");
  await expect(nav.getByRole("link", { name: "Live-Lage" })).toHaveAttribute(
    "href",
    /\/lage\?.*tag=2026-09-20/,
  );
});

test("each page names itself in the document title", async ({ page }) => {
  const pages = [
    ["/karte", "Karte"],
    ["/lage", "Live-Lage"],
    ["/bahnhof/8000207", "Köln Hbf"],
    ["/linie/RE57%3A08000080", "RE57 Dortmund Hbf – Warburg (Westf)"],
    ["/muster/heatmap", "Wochentag × Uhrzeit"],
    ["/muster/rankings", "Rankings"],
    ["/muster/zeitverlauf", "Zeitverlauf"],
    ["/impressum", "Impressum"],
    ["/datenschutz", "Datenschutz"],
    ["/mehr", "Mehr"],
  ];
  for (const [path, name] of pages) {
    await page.goto(path);
    await expect(page, path).toHaveTitle(`${name} · Gleisatlas`);
  }
  // A move inside the app renames the tab too.
  await page.evaluate(() => {
    history.pushState(null, "", "/muster/rankings");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveTitle("Rankings · Gleisatlas");
});

test("Inter is loaded", async ({ page }) => {
  await page.goto("/muster/heatmap");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    let face = false;
    document.fonts.forEach((f) => {
      if (f.family.replace(/"/g, "") === "Inter Variable" && f.status === "loaded") face = true;
    });
    return face && document.fonts.check('14px "Inter Variable"');
  });
  expect(loaded).toBe(true);
});

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  test("sidebar marks the current page and shows unbuilt pages as 'bald'", async ({ page }) => {
    await page.goto("/muster/heatmap?g=fern");
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    const current = nav.getByRole("link", { name: "Wochentag × Uhrzeit" });
    await expect(current).toHaveAttribute("aria-current", "page");
    await expect(current).toHaveAttribute("href", "/muster/heatmap?g=fern");
    await expect(nav.getByRole("link", { name: "Karte" })).toHaveAttribute("href", "/karte?g=fern");
    for (const name of UNBUILT) {
      await expect(nav.getByText(name, { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name })).toHaveCount(0);
    }
    const note = page.getByTestId("data-note");
    await expect(note.getByText("Datenstand: Sept. 2026 · 5.219 Bahnhöfe")).toBeVisible();
    await expect(note).toContainText("Kein Angebot der Deutschen Bahn");
    await expect(note).not.toContainText("piebro");
  });

  test("Live-Lage is a link after Karte, current on its page and keeps the metric", async ({
    page,
  }) => {
    await page.goto("/lage?k=median");
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    const live = nav.getByRole("link", { name: "Live-Lage" });
    await expect(live).toHaveAttribute("aria-current", "page");
    await expect(live).toHaveAttribute("href", "/lage?k=median");
    await expect(nav.getByRole("link", { name: "Karte" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.getByRole("link")).toHaveText([
      "Karte",
      "Live-Lage",
      "Wochentag × Uhrzeit",
      "Rankings",
      "Zeitverlauf",
    ]);
    // It is built, so the list of unbuilt pages does not have it any more.
    await expect(nav.getByText("Live-Lage", { exact: true })).toHaveCount(1);
  });
});

test.describe("mobile", { tag: "@phone" }, () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("tab bar replaces the sidebar, heatmap is transposed, no sideways scroll", async ({
    page,
  }) => {
    await page.goto("/muster/heatmap");
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    await expect(nav).toHaveCount(1);
    await expect(nav.getByRole("link", { name: "Muster" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Mehr" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Karte" })).toHaveAttribute("href", "/karte");
    await expect(nav.getByRole("link", { name: /Planen/ })).toHaveCount(0);
    await expect(nav.getByRole("link")).toHaveText(["Karte", "Live-Lage", "Muster", "Mehr"]);
    await expect(
      page.getByRole("link", { name: "Wochentag × Uhrzeit", includeHidden: true }),
    ).toBeHidden();
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("the Live-Lage tab leads to /lage and is current there", async ({ page }) => {
    await page.goto("/lage?k=p90");
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    await expect(nav.getByRole("link", { name: "Live-Lage" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.getByRole("link", { name: "Karte" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    await nav.getByRole("link", { name: "Muster" }).click();
    await expect(page).toHaveURL(/\/muster\/heatmap\?k=p90$/);
    await nav.getByRole("link", { name: "Live-Lage" }).click();
    await expect(page).toHaveURL(/\/lage\?k=p90$/);
  });

  test("the Muster switch moves between Heatmap, Rankings and Zeitverlauf", async ({ page }) => {
    await page.goto("/muster/heatmap?g=fern");
    const nav = page.getByRole("navigation", { name: "Muster", exact: true });
    const tab = page
      .getByRole("navigation", { name: "Hauptnavigation" })
      .getByRole("link", { name: "Muster" });
    await expect(nav.getByRole("link", { name: "Heatmap" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await nav.getByRole("link", { name: "Rankings" }).click();
    await expect(page).toHaveURL(/\/muster\/rankings\?g=fern$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rankings");
    await expect(nav.getByRole("link", { name: "Rankings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(tab).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Zeitverlauf" }).click();
    await expect(page).toHaveURL(/\/muster\/zeitverlauf\?g=fern$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Zeitverlauf");
    await expect(nav.getByRole("link", { name: "Zeitverlauf" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(tab).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Heatmap" }).click();
    await expect(page).toHaveURL(/\/muster\/heatmap\?g=fern$/);
  });

  test("the Muster tab leads to the heatmap and keeps the filters", async ({ page }) => {
    await page.goto("/karte?g=fern");
    await page
      .getByRole("navigation", { name: "Hauptnavigation" })
      .getByRole("link", { name: "Muster" })
      .click();
    await expect(page).toHaveURL(/\/muster\/heatmap\?g=fern$/);
  });

  test("Mehr lists the remaining pages, the data status and the DB note", async ({ page }) => {
    await page.goto("/muster/heatmap");
    await page.getByRole("link", { name: "Mehr" }).click();
    await expect(page).toHaveURL(/\/mehr$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mehr");
    const main = page.getByRole("main");
    await expect(main.getByText("Umstieg prüfen", { exact: true })).toBeVisible();
    // Planen moved here from the tab bar; Live-Lage is built and has its own tab.
    await expect(main.getByText("Planen", { exact: true })).toBeVisible();
    await expect(main.getByText("Live-Lage")).toHaveCount(0);
    const note = main.getByTestId("data-note");
    await expect(note.getByText("Datenstand: Sept. 2026 · 5.219 Bahnhöfe")).toBeVisible();
    await expect(note).toContainText("Kein Angebot der Deutschen Bahn");
    await expect(note).not.toContainText("piebro");
  });
});
