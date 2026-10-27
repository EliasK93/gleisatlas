import { expect, test, type Page } from "@playwright/test";
import { IMPRESSUM, mockApi } from "./fixtures";

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test("the map links to the legal pages: in the sidebar, or via Mehr on a phone", async ({
  page,
  isMobile,
}) => {
  await page.goto("/karte");
  await expect(page.getByRole("contentinfo")).toHaveCount(0);
  if (isMobile) await page.getByRole("link", { name: "Mehr" }).click();
  await page.getByRole("link", { name: "Impressum" }).click();
  await expect(page).toHaveURL(/\/impressum$/);
  await expect(h1(page)).toHaveText("Impressum");
  await page.getByRole("contentinfo").getByRole("link", { name: "Datenschutz" }).click();
  await expect(page).toHaveURL(/\/datenschutz$/);
  await expect(h1(page)).toHaveText("Datenschutz");
});

test("a page with a footer links to both in the footer", async ({ page }) => {
  await page.goto("/muster/heatmap");
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: "Impressum" })).toHaveAttribute(
    "href",
    "/impressum",
  );
  await footer.getByRole("link", { name: "Datenschutz" }).click();
  await expect(page).toHaveURL(/\/datenschutz$/);
});

test("the footer links to the source code, which carries the licences", async ({ page }) => {
  await page.goto("/muster/heatmap");
  await expect(
    page.getByRole("contentinfo").getByRole("link", { name: "Quellcode" }),
  ).toHaveAttribute("href", "https://github.com/EliasK93/gleisatlas");
});

test("the legal links keep the filters in the query string", async ({ page }) => {
  await page.goto("/muster/heatmap?g=fern");
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: "Impressum" })).toHaveAttribute(
    "href",
    "/impressum?g=fern",
  );
  await footer.getByRole("link", { name: "Datenschutz" }).click();
  await expect(page).toHaveURL(/\/datenschutz\?g=fern$/);
  await page.getByRole("main").getByRole("link", { name: "Impressum" }).click();
  await expect(page).toHaveURL(/\/impressum\?g=fern$/);
});

test("the Impressum shows the provider from the build environment", async ({ page }) => {
  await page.goto("/impressum");
  const main = page.getByRole("main");
  for (const line of [IMPRESSUM.name, IMPRESSUM.street, IMPRESSUM.city])
    await expect(main).toContainText(line);
  await expect(main.getByRole("link", { name: IMPRESSUM.email })).toHaveAttribute(
    "href",
    `mailto:${IMPRESSUM.email}`,
  );
});

test("the privacy page names the controller and the map provider", async ({ page }) => {
  await page.goto("/datenschutz");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 2 })).toHaveCount(6);
  await expect(main.getByRole("link", { name: "Impressum" })).toHaveAttribute("href", "/impressum");
  await expect(main.getByRole("link", { name: "OpenFreeMap" })).toHaveAttribute(
    "href",
    "https://openfreemap.org",
  );
  await expect(main).toContainText("tiles.openfreemap.org");
});

test.describe("English browser", () => {
  test.use({ locale: "en-US" });

  test("both pages read in English", async ({ page }) => {
    await page.goto("/impressum");
    await expect(h1(page)).toHaveText("Legal notice");
    await expect(page.getByRole("main")).toContainText(IMPRESSUM.name);
    await page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }).click();
    await expect(h1(page)).toHaveText("Privacy");
    await expect(page.getByRole("main")).toContainText("OpenFreeMap");
    await expect(page.getByRole("main").getByRole("link", { name: "Legal notice" })).toBeVisible();
  });
});
