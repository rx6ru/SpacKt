import { expect, test } from "@playwright/test";

test("test harness page renders before market product behavior exists", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "SpacKt test harness" })).toBeVisible();
});
