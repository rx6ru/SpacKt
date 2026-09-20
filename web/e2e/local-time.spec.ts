import { expect, type Browser, type BrowserContext, type Page, test } from "@playwright/test";

const frontendURL = process.env.WEB_URL ?? "http://127.0.0.1:3000";

type ObservedTimes = {
  trades: number[];
  candles: number[];
};

async function newTimezonePage(browser: Browser, timezoneId: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ timezoneId });
  const page = await context.newPage();
  await installTimeObserver(page);
  return { context, page };
}

async function installTimeObserver(page: Page) {
  await page.addInitScript(() => {
    const observedWindow = window as unknown as Window & {
      __spacktTimes: {
        trades: number[];
        candles: number[];
      };
    };
    const NativeWebSocket = window.WebSocket;

    observedWindow.__spacktTimes = { trades: [], candles: [] };
    window.WebSocket = class TimeObservedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          try {
            const data = JSON.parse(event.data) as {
              type?: string;
              trades?: Array<{ t: number }>;
              candles?: { items?: Array<{ t: number }> };
            };
            if (data.type !== "update") return;
            for (const trade of data.trades ?? []) {
              observedWindow.__spacktTimes.trades.push(trade.t);
            }
            for (const candle of data.candles?.items ?? []) {
              observedWindow.__spacktTimes.candles.push(candle.t);
            }
          } catch {
            return;
          }
        });
      }
    };
  });
}

async function gotoMarket(page: Page) {
  await page.goto(frontendURL);
  await expect(
    page.getByRole("main", { name: "SpacKt market console" }),
  ).toBeVisible();
}

function region(page: Page, name: string) {
  return page.getByRole("region", { name });
}

function chartLocalTime(page: Page) {
  return region(page, "Candlestick chart")
    .locator(".legend-cell")
    .filter({ has: page.getByText("Local time", { exact: true }) })
    .locator("strong");
}

async function observedTimes(page: Page, key: keyof ObservedTimes) {
  return page.evaluate((observedKey) => {
    const observedWindow = window as unknown as Window & {
      __spacktTimes?: ObservedTimes;
    };
    return observedWindow.__spacktTimes?.[observedKey].slice(-50) ?? [];
  }, key);
}

async function formatTimeOnlyInBrowser(page: Page, timeMsValues: number[]) {
  return page.evaluate((value) =>
    value.map((timeMs) => new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(timeMs))),
  timeMsValues);
}

async function firstTradeTimeCell(page: Page) {
  return region(page, "Recent trades")
    .locator('[role="row"]:not(.table-head):not(.skipped)')
    .first()
    .locator('[role="cell"]')
    .first()
    .textContent();
}

async function expectDashboardUsesBrowserLocalTime(page: Page) {
  await gotoMarket(page);
  await expect(region(page, "Connection and delivery").getByText("Live")).toBeVisible({
    timeout: 20_000,
  });

  await expect.poll(async () => (await observedTimes(page, "trades")).length, {
    timeout: 20_000,
  }).toBeGreaterThan(0);
  const summary = region(page, "Market summary");
  const trades = region(page, "Recent trades");

  await expect
    .poll(async () => (await summary.textContent()) ?? "")
    .toMatch(/Last trade \d{2}:\d{2}:\d{2} (?:GMT|[A-Z]{2,4})/);
  await expect(trades.getByText("Time (local)", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const expectedTradeTimes = await formatTimeOnlyInBrowser(page, await observedTimes(page, "trades"));
    const visibleTime = (await firstTradeTimeCell(page))?.trim() ?? "";
    return expectedTradeTimes.includes(visibleTime);
  }).toBe(true);

  await expect.poll(async () => (await observedTimes(page, "candles")).length, {
    timeout: 20_000,
  }).toBeGreaterThan(0);

  await expect.poll(async () => {
    const expectedCandleTimes = await formatTimeOnlyInBrowser(page, await observedTimes(page, "candles"));
    const visibleTime = (await chartLocalTime(page).textContent())?.trim() ?? "";
    return expectedCandleTimes.includes(visibleTime);
  }, { timeout: 20_000 }).toBe(true);
}

test("shows live market times in Asia Kolkata browser time", async ({ browser }) => {
  const { context, page } = await newTimezonePage(browser, "Asia/Kolkata");
  try {
    await expectDashboardUsesBrowserLocalTime(page);
  } finally {
    await context.close();
  }
});

test("shows live market times in New York browser time", async ({ browser }) => {
  const { context, page } = await newTimezonePage(browser, "America/New_York");
  try {
    await expectDashboardUsesBrowserLocalTime(page);
  } finally {
    await context.close();
  }
});
