import { expect, test } from "@playwright/test";

test("renders the market console main region", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("main", { name: "SpacKt market console" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "SpacKt test harness" }),
  ).toHaveCount(0);
});
