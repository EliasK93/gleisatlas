import { expect, test } from "@playwright/test";

test("the shell shows title, disclaimer and attribution", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("banner").getByRole("heading", { name: "Verlässlich" }),
  ).toBeVisible();
  const footer = page.getByRole("contentinfo");
  await expect(footer).toContainText("Historische Statistik, keine Prognose oder Garantie");
  await expect(footer).toContainText("CC BY 4.0");
  await expect(page.getByRole("main")).toBeAttached();
});
