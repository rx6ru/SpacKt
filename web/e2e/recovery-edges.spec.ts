import { expect, type Locator, type Page, test } from "@playwright/test";

const moneyText = /\$\d{1,3}(?:,\d{3})*\.\d{2}\b/;

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

  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open diagnostics" }).click();
  }

  await expect(dialog).toBeVisible();
  return dialog;
}

function latestPrice(page: Page) {
  return region(page, "Market summary").getByLabel("Latest price");
}

async function expectLiveWithPrice(page: Page) {
  await expect(region(page, "Connection and delivery").getByText("Live")).toBeVisible({
    timeout: 20_000,
  });
  await expect(latestPrice(page)).toHaveText(moneyText, { timeout: 20_000 });
}

function chartLocalTime(page: Page) {
  return region(page, "Candlestick chart")
    .locator(".legend-cell")
    .filter({ has: page.getByText("Local time", { exact: true }) })
    .locator("strong");
}

function formatLocalTime(timeMs: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timeMs));
}

async function bookSeq(page: Page) {
  const text = await region(page, "Order book").textContent();
  const match = text?.match(/Seq\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

function emptyHistoryBody(source: string) {
  const body = JSON.parse(source) as {
    session: string;
    symbol: string;
    interval: string;
    requestId: number;
    candles: unknown[];
  };
  return JSON.stringify({ ...body, candles: [] });
}

function distinctHistoryBody(source: string) {
  const body = JSON.parse(source) as {
    candles: Array<{ t: number; o: string; h: string; l: string; c: string; v: string; rev: number; closed: boolean }>;
  };
  const candles = body.candles.slice(-2).map((candle, index) => ({
    ...candle,
    o: "1.00",
    h: "1.25",
    l: "0.75",
    c: index === 0 ? "1.11" : "1.23",
    v: "1.0000",
    rev: candle.rev + 10_000,
  }));
  return JSON.stringify({ ...body, candles });
}

async function installBufferedCandleFrames(page: Page, interval: "1s" | "1m" | "5m") {
  await page.addInitScript((targetInterval) => {
    type PendingFrame = { socket: WebSocket; data: string };
    const controlledWindow = window as Window & {
      __spacktReleaseBufferedCandles?: () => void;
    };
    const NativeWebSocket = window.WebSocket;
    const pending: PendingFrame[] = [];
    let released = false;

    controlledWindow.__spacktReleaseBufferedCandles = () => {
      released = true;
      for (const frame of pending.splice(0)) {
        frame.socket.dispatchEvent(new MessageEvent("message", { data: frame.data }));
      }
    };

    window.WebSocket = class BufferedCandleWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          if (
            !released &&
            typeof event.data === "string" &&
            event.data.includes('"candles"') &&
            event.data.includes(`"interval":"${targetInterval}"`)
          ) {
            event.stopImmediatePropagation();
            pending.push({ socket: this, data: event.data });
          }
        }, true);
      }
    };
  }, interval);
}

async function releaseBufferedCandleFrames(page: Page) {
  await page.evaluate(() => {
    const controlledWindow = window as Window & {
      __spacktReleaseBufferedCandles?: () => void;
    };
    controlledWindow.__spacktReleaseBufferedCandles?.();
  });
}

test("keeps cached values while offline and recovers online", async ({ context, page }) => {
  await gotoMarket(page);
  await expectLiveWithPrice(page);

  await context.setOffline(true);

  await expect(region(page, "Connection and delivery").getByText("Offline")).toBeVisible();
  await expect(region(page, "Connection and delivery").getByText("Cached values")).toBeVisible();
  const cachedPrice = await latestPrice(page).textContent();
  await page.waitForTimeout(400);
  await expect(latestPrice(page)).toHaveText(cachedPrice ?? "");

  await context.setOffline(false);

  await expectLiveWithPrice(page);
});

test("ignores old interval history after a newer selection", async ({ page, request }) => {
  await gotoMarket(page);
  await expectLiveWithPrice(page);

  let releaseOldHistory!: () => void;
  const oldHistoryHeld = new Promise<void>((resolve) => {
    releaseOldHistory = resolve;
  });
  let oldHistoryReleased = false;
  let oldHistoryLocalTime = "";
  let oneSecondLatestLocalTime = "";
  const release = () => {
    if (!oldHistoryReleased) {
      oldHistoryReleased = true;
      releaseOldHistory();
    }
  };

  await page.route("**/api/candles?**", async (route) => {
    const url = new URL(route.request().url());
    const interval = url.searchParams.get("interval");
    if (interval !== "5m" && interval !== "1s") {
      await route.continue();
      return;
    }

    const response = await request.get(route.request().url());
    const body = await response.text();
    if (interval === "1s") {
      const parsed = JSON.parse(body) as { candles: Array<{ t: number }> };
      const latest = parsed.candles.at(-1);
      oneSecondLatestLocalTime = latest ? formatLocalTime(latest.t) : "";
      await route.fulfill({
        status: response.status(),
        headers: await response.headers(),
        body,
      }).catch(() => undefined);
      return;
    }

    const oldParsed = JSON.parse(body) as { candles: Array<{ t: number }> };
    const oldLatest = oldParsed.candles.at(-1);
    oldHistoryLocalTime = oldLatest ? formatLocalTime(oldLatest.t) : "";
    await oldHistoryHeld;
    await route.fulfill({
      status: response.status(),
      headers: await response.headers(),
      body: distinctHistoryBody(body),
    }).catch(() => undefined);
  });

  try {
    const chart = region(page, "Candlestick chart");
    await chart.getByRole("radio", { name: "5m" }).click();
    await expect(chart.getByText("Loading 5m history")).toBeVisible();

    await chart.getByRole("radio", { name: "1s" }).click();
    release();

    await expect(chart.getByRole("radio", { name: "1s" })).toHaveAttribute("aria-checked", "true");
    await expect(chart.getByText("Loading 5m history")).toBeHidden();
    await expect(chart.getByText("Loading 1s history")).toBeHidden({ timeout: 20_000 });
    await expect(chartLocalTime(page)).not.toHaveText("-", { timeout: 20_000 });
    await expect.poll(() => oneSecondLatestLocalTime).not.toBe("");
    await expect(chartLocalTime(page)).toHaveText(oneSecondLatestLocalTime);
    if (oldHistoryLocalTime) {
      await expect(chartLocalTime(page)).not.toHaveText(oldHistoryLocalTime);
    }
    await expect(chart.getByText("1.23")).toBeHidden();
  } finally {
    release();
    await page.unroute("**/api/candles?**").catch(() => undefined);
  }
});

test("renders live candles after a valid empty history", async ({ page, request }) => {
  await installBufferedCandleFrames(page, "1s");
  await gotoMarket(page);
  await expectLiveWithPrice(page);

  let fulfilledEmptyHistory = false;
  await page.route("**/api/candles?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("interval") !== "1s" || fulfilledEmptyHistory) {
      await route.continue();
      return;
    }

    const response = await request.get(route.request().url());
    fulfilledEmptyHistory = true;
    await route.fulfill({
      status: response.status(),
      headers: await response.headers(),
      body: emptyHistoryBody(await response.text()),
    });
  });

  try {
    const chart = region(page, "Candlestick chart");
    await chart.getByRole("radio", { name: "1s" }).click();
    await expect.poll(() => fulfilledEmptyHistory).toBe(true);
    await expect(chart.getByText("No history yet. Live candles will appear here.")).toBeVisible();
    await releaseBufferedCandleFrames(page);
    await expect(chartLocalTime(page)).not.toHaveText("-", { timeout: 20_000 });
    await expect(chart.getByText("No history yet. Live candles will appear here.")).toBeHidden();
    await expect(chart.getByRole("radio", { name: "1s" })).toHaveAttribute("aria-checked", "true");
    await expect(chart.getByText("Chart unavailable")).toBeHidden();
  } finally {
    await releaseBufferedCandleFrames(page).catch(() => undefined);
    await page.unroute("**/api/candles?**").catch(() => undefined);
  }
});

test("keeps market data intact after one malformed socket frame", async ({ context, page }) => {
  await context.setOffline(false);
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;

    window.WebSocket = class InjectedFrameWebSocket extends NativeWebSocket {
      private injected = false;

      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", () => {
          if (this.injected) return;
          this.injected = true;
          window.setTimeout(() => {
            this.dispatchEvent(new MessageEvent("message", { data: "{" }));
          }, 1000);
        });
      }
    };
  });

  await gotoMarket(page);
  await expectLiveWithPrice(page);
  const seqBeforeBadFrame = await bookSeq(page);

  const panel = await diagnostics(page);
  await expect(
    panel
      .locator(".diagnostic-item")
      .filter({ has: page.getByText("Bad messages", { exact: true }) })
      .locator("strong"),
  ).toHaveText("1");
  await panel.getByRole("button", { name: "Close diagnostics" }).click();
  await expect(panel).toBeHidden();
  await expect(latestPrice(page)).toHaveText(moneyText);
  await expect.poll(() => bookSeq(page), { timeout: 20_000 }).toBeGreaterThan(seqBeforeBadFrame);
  await expect(region(page, "Order book").getByText(/^ASK$/)).toHaveCount(10);
  await expect(region(page, "Order book").getByText(/^BID$/)).toHaveCount(10);
});
