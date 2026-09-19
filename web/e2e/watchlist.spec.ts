import { expect, type Locator, type Page, test } from "@playwright/test";

const defaultOrder = ["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD", "AVAX-USD"];

async function gotoMarket(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("main", { name: "SpacKt market console" })).toBeVisible();
}

function watchlist(page: Page) {
  return page.getByRole("region", { name: "Watchlist" });
}

function list(page: Page) {
  return watchlist(page).getByRole("list", { name: "Watchlist" });
}

function row(page: Page, symbol: string) {
  return list(page).getByRole("listitem", { name: new RegExp(symbol) });
}

async function rowOrder(page: Page) {
  return list(page).getByRole("listitem").evaluateAll((items, symbols) =>
    items.map((item) => {
      const text = item.textContent ?? "";
      const symbol = symbols.find((candidate) => text.includes(candidate));
      if (!symbol) {
        throw new Error(`watchlist row has no known symbol: ${text}`);
      }
      return symbol;
    }),
    defaultOrder,
  );
}

async function expectOrder(page: Page, expected: string[]) {
  await expect.poll(() => rowOrder(page)).toEqual(expected);
}

async function activeElementIsInside(locator: Locator) {
  return locator.evaluate((element) =>
    Boolean(document.activeElement && element.contains(document.activeElement)),
  );
}

test("moves a watchlist row with Space and persists the order after reload", async ({ page }) => {
  await gotoMarket(page);
  await expectOrder(page, defaultOrder);

  const ethMoveDown = row(page, "ETH-USD").getByRole("button", { name: "Move ETH-USD down" });
  await ethMoveDown.focus();
  await page.keyboard.press("Space");

  await expectOrder(page, ["BTC-USD", "SOL-USD", "ETH-USD", "LINK-USD", "AVAX-USD"]);
  await expect.poll(() => activeElementIsInside(row(page, "ETH-USD"))).toBe(true);

  await page.reload();
  await expect(page.getByRole("main", { name: "SpacKt market console" })).toBeVisible();
  await expectOrder(page, ["BTC-USD", "SOL-USD", "ETH-USD", "LINK-USD", "AVAX-USD"]);
});

test("moves BTC-USD to final index one with native pointer drag", async ({ page }) => {
  await gotoMarket(page);
  const source = row(page, "BTC-USD").getByRole("button", { name: "Drag BTC-USD" });
  const target = row(page, "ETH-USD");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  await expectOrder(page, ["ETH-USD", "BTC-USD", "SOL-USD", "LINK-USD", "AVAX-USD"]);
  await expect.poll(() => activeElementIsInside(row(page, "BTC-USD"))).toBe(true);
});

test("keeps the order when a real pointer drag is canceled", async ({ page }) => {
  await gotoMarket(page);
  const source = row(page, "BTC-USD").getByRole("button", { name: "Drag BTC-USD" });
  const target = row(page, "ETH-USD");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  await source.focus();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();

  await expectOrder(page, defaultOrder);
  await expect.poll(() => activeElementIsInside(row(page, "BTC-USD"))).toBe(true);
});

test("provides named drag handles and no feed navigation for preview rows", async ({ page }) => {
  await gotoMarket(page);

  for (const symbol of defaultOrder) {
    await expect(row(page, symbol).getByRole("button", { name: `Drag ${symbol}` })).toBeVisible();
  }
  for (const symbol of ["ETH-USD", "SOL-USD", "LINK-USD", "AVAX-USD"]) {
    await expect(row(page, symbol).getByRole("link")).toHaveCount(0);
  }
});
