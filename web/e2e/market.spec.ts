import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

const moneyText = /\b\d{1,3}(?:,\d{3})*\.\d{2}\b/;
const backendURL = process.env.BACKEND_URL ?? "http://127.0.0.1:8080";

async function gotoMarket(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("main", { name: "SpacKt market console" }),
  ).toBeVisible();
}

function region(page: Page, name: string) {
  return page.getByRole("region", { name });
}

async function diagnostics(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog", {
    name: "Diagnostics and debug controls",
  });
  const regionPanel = page.getByRole("region", {
    name: "Diagnostics and debug controls",
  });
  const panel = dialog.or(regionPanel).first();

  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open diagnostics" }).click();
  }

  await expect(dialog.or(regionPanel).first()).toBeVisible();
  if (await dialog.isVisible().catch(() => false)) {
    return dialog;
  }
  return regionPanel;
}

async function forceTier(panel: Locator, label: string) {
  const field = panel.getByLabel("Force delivery tier");

  try {
    await field.selectOption({ label }, { timeout: 1_000 });
    return;
  } catch {
    await panel.getByRole("button", { name: label }).click();
  }
}

async function fetchReferencePrice(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${backendURL}/api/meta`);
  expect(response.ok()).toBe(true);

  const meta = (await response.json()) as { referencePrice: string };
  return formatMoney(meta.referencePrice);
}

function formatMoney(value: string) {
  const [integerPart, fractionPart = ""] = value.split(".");
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${fractionPart.padEnd(2, "0").slice(0, 2)}`;
}

test("shows all required market regions", async ({ page }) => {
  await gotoMarket(page);

  await expect(region(page, "Market summary")).toBeVisible();
  await expect(region(page, "Candlestick chart")).toBeVisible();
  await expect(region(page, "Order book")).toBeVisible();
  await expect(region(page, "Recent trades")).toBeVisible();
  await expect(region(page, "Connection and delivery")).toBeVisible();
  await expect(region(page, "Watchlist")).toBeVisible();
  await diagnostics(page);
});

test("shows live BTC-USD price and ten book rows per side", async ({
  page,
  request,
}) => {
  const referencePrice = await fetchReferencePrice(request);

  await gotoMarket(page);

  const summary = region(page, "Market summary");
  await expect(summary.getByText("BTC-USD")).toBeVisible();
  await expect(summary.getByText("From session start")).toBeVisible();
  await expect(summary.getByText(`Reference price ${referencePrice}`)).toBeVisible();
  await expect(summary.getByText(moneyText)).toBeVisible();

  const book = region(page, "Order book");
  await expect(book.getByText("Spread")).toBeVisible();
  await expect(book.getByText("Book status")).toBeVisible();
  await expect(book.getByText(/^ASK$/)).toHaveCount(10);
  await expect(book.getByText(/^BID$/)).toHaveCount(10);
});

test("switches chart intervals with pressed state", async ({ page }) => {
  await gotoMarket(page);

  const chart = region(page, "Candlestick chart");
  await expect(chart.getByRole("group", { name: "Chart interval" })).toBeVisible();
  await expect(chart.getByRole("button", { name: "1m" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await chart.getByRole("button", { name: "1s" }).click();
  await expect(chart.getByRole("button", { name: "1s" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await chart.getByRole("button", { name: "5m" }).click();
  await expect(chart.getByRole("button", { name: "5m" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await chart.getByRole("button", { name: "1m" }).click();
  await expect(chart.getByRole("button", { name: "1m" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("supports keyboard candle inspection", async ({ page }) => {
  await gotoMarket(page);

  const chart = region(page, "Candlestick chart");
  await expect(chart.getByText("UTC")).toBeVisible();
  await expect(chart.getByText(/\bO\b/)).toBeVisible();
  await expect(chart.getByText(/\bH\b/)).toBeVisible();
  await expect(chart.getByText(/\bL\b/)).toBeVisible();
  await expect(chart.getByText(/\bC\b/)).toBeVisible();
  await expect(chart.getByText(/\bV\b/)).toBeVisible();

  await chart.getByRole("button", { name: "Previous candle" }).press("Enter");
  await expect(chart.getByText(/Inspecting candle/)).toBeVisible();

  await chart.getByRole("button", { name: "Next candle" }).press("Enter");
  await expect(chart.getByText(/Inspecting candle/)).toBeVisible();
});

test("separates configured and observed delivery rates", async ({ page }) => {
  await gotoMarket(page);

  const status = region(page, "Connection and delivery");
  await expect(status.getByText("Connection")).toBeVisible();
  await expect(status.getByText("Tier")).toBeVisible();
  await expect(status.getByText("Configured target")).toBeVisible();
  await expect(status.getByText("Observed")).toBeVisible();
  await expect(status.getByText("RTT")).toBeVisible();
  await expect(status.getByText("Jitter")).toBeVisible();

  const panel = await diagnostics(page);
  await expect(panel.getByText(/Configured target|Target/)).toBeVisible();
  await expect(panel.getByText(/Observed/)).toBeVisible();
  await expect(panel.getByText(/over \d+(?:\.\d+)? s|-/)).toBeVisible();
});

test("forces each delivery tier and returns to auto", async ({ page }) => {
  await gotoMarket(page);
  const panel = await diagnostics(page);

  await forceTier(panel, "Full");
  await expect(panel.getByText(/Forced full\. Auto would be/)).toBeVisible();
  await page.waitForTimeout(1_050);

  await forceTier(panel, "Degraded");
  await expect(panel.getByText(/Forced degraded\. Auto would be/)).toBeVisible();
  await page.waitForTimeout(1_050);

  await forceTier(panel, "Minimal");
  await expect(panel.getByText(/Forced minimal\. Auto would be/)).toBeVisible();
  await expect(panel.getByText(/Configured target|Target/)).toBeVisible();
  await expect(panel.getByText(/Observed/)).toBeVisible();
  await page.waitForTimeout(1_050);

  await forceTier(panel, "Auto");
  await expect(panel.getByText(/Forced (full|degraded|minimal)\. Auto would be/)).toHaveCount(0);
});

test("shows cached stale data after disconnect and recovers", async ({ page }) => {
  await gotoMarket(page);

  const summary = region(page, "Market summary");
  await expect(summary.getByText(moneyText)).toBeVisible();

  const panel = await diagnostics(page);
  await panel.getByRole("button", { name: "Disconnect this session" }).click();

  await expect(page.getByText(/Stale since|Reconnecting in|Offline/)).toBeVisible();
  await expect(summary.getByText(moneyText)).toBeVisible();
  await expect(region(page, "Connection and delivery").getByText(/Live/)).toBeVisible({
    timeout: 20_000,
  });
});

test("shows book gap recovery without clearing cached rows", async ({ page }) => {
  await gotoMarket(page);

  const book = region(page, "Order book");
  await expect(book.getByText(/^ASK$/)).toHaveCount(10);
  await expect(book.getByText(/^BID$/)).toHaveCount(10);

  const panel = await diagnostics(page);
  await panel.getByRole("button", { name: "Drop next book delta" }).click();

  await expect(
    page.getByText(/Gap detected\. Fetching snapshot\.|Book resyncing/),
  ).toBeVisible();
  await expect(book.getByText(/^ASK$/)).toHaveCount(10);
  await expect(book.getByText(/^BID$/)).toHaveCount(10);
  await expect(book.getByText(/synced/i)).toBeVisible({ timeout: 20_000 });
});

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
] as const) {
  test(`keeps required panels reachable without page overflow at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await gotoMarket(page);

    for (const name of [
      "Market summary",
      "Candlestick chart",
      "Order book",
      "Recent trades",
      "Connection and delivery",
      "Watchlist",
    ]) {
      await region(page, name).scrollIntoViewIfNeeded();
      await expect(region(page, name)).toBeVisible();
    }

    const hasDocumentOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(hasDocumentOverflow).toBe(false);
  });
}
