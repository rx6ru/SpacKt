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

  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open diagnostics" }).click();
  }

  await expect(dialog).toBeVisible();
  return dialog;
}

async function forceTier(panel: Locator, label: string) {
  const option = panel.getByRole("radio", { name: label });
  await expect(option).toBeVisible();
  await option.click();
}

async function expectTierSelected(panel: Locator, label: string) {
  await expect(panel.getByRole("radio", { name: label })).toHaveAttribute(
    "aria-checked",
    "true",
  );
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

function formatUTC(timeMs: number) {
  return new Date(timeMs).toISOString().slice(11, 19);
}

async function expectTextContent(locator: Locator, pattern: RegExp | string) {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () => (await locator.textContent())?.trim() ?? "")
    .toMatch(pattern instanceof RegExp ? pattern : new RegExp(escapeRegex(pattern)));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function installWebSocketObserver(page: Page) {
  await page.addInitScript(() => {
    type SocketEvent = {
      type: "open" | "close";
      url: string;
      latestPriceText: string | null;
    };
    const observedWindow = window as unknown as Window & {
      __spacktSocketEvents: SocketEvent[];
    };
    const NativeWebSocket = window.WebSocket;

    observedWindow.__spacktSocketEvents = [];
    window.WebSocket = class ObservedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketURL = String(url);

        this.addEventListener("open", () => {
          observedWindow.__spacktSocketEvents.push({
            type: "open",
            url: socketURL,
            latestPriceText: null,
          });
        });
        this.addEventListener("close", () => {
          observedWindow.__spacktSocketEvents.push({
            type: "close",
            url: socketURL,
            latestPriceText:
              document
                .querySelector('[aria-label="Latest price"]')
                ?.textContent?.trim() ?? null,
          });
        });
      }
    };
  });
}

async function socketEventCount(page: Page, type: "open" | "close") {
  return page.evaluate((eventType) => {
    const observedWindow = window as Window & {
      __spacktSocketEvents?: Array<{
        type: "open" | "close";
        url: string;
        latestPriceText: string | null;
      }>;
    };

    return (observedWindow.__spacktSocketEvents ?? []).filter(
      (event) => event.type === eventType,
    ).length;
  }, type);
}

async function socketCloseLatestPrice(page: Page, closeIndex: number) {
  return page.evaluate((index) => {
    const observedWindow = window as Window & {
      __spacktSocketEvents?: Array<{
        type: "open" | "close";
        url: string;
        latestPriceText: string | null;
      }>;
    };

    return (observedWindow.__spacktSocketEvents ?? []).filter(
      (event) => event.type === "close",
    )[index]?.latestPriceText ?? null;
  }, closeIndex);
}

async function activeElementIsInside(locator: Locator) {
  return locator.evaluate((element) =>
    Boolean(document.activeElement && element.contains(document.activeElement)),
  );
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
  await expectTextContent(summary.getByLabel("Reference price"), referencePrice);
  await expectTextContent(summary.getByLabel("Latest price"), moneyText);

  const book = region(page, "Order book");
  await expect(book.getByText("Spread")).toBeVisible();
  await expect(book.getByText("Book status")).toBeVisible();
  await expect(book.getByText(/^ASK$/)).toHaveCount(10);
  await expect(book.getByText(/^BID$/)).toHaveCount(10);
});

test("switches chart intervals with pressed state", async ({ page }) => {
  await gotoMarket(page);

  const chart = region(page, "Candlestick chart");
  const intervalGroup = chart.getByRole("radiogroup", { name: "Chart interval" });
  const oneSecond = chart.getByRole("radio", { name: "1s" });
  const oneMinute = chart.getByRole("radio", { name: "1m" });
  const fiveMinute = chart.getByRole("radio", { name: "5m" });

  await expect(intervalGroup).toBeVisible();
  await expect(oneMinute).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await oneMinute.focus();
  await page.keyboard.press("ArrowRight");
  await expect(fiveMinute).toBeFocused();
  await expect(oneMinute).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("Space");
  await expect(fiveMinute).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await oneSecond.click();
  await expect(oneSecond).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await oneMinute.click();
  await expect(oneMinute).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("fits delayed history after a live seed", async ({ page, request }) => {
  await gotoMarket(page);

  await expect(region(page, "Connection and delivery").getByText("Live")).toBeVisible({
    timeout: 20_000,
  });
  const chart = region(page, "Candlestick chart");
  let releaseHistory!: () => void;
  const holdHistory = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let heldHistory: {
    body: string;
    status: number;
    headers: Record<string, string>;
  } | null = null;
  let historyReleased = false;
  const releaseHeldHistory = () => {
    if (!historyReleased) {
      historyReleased = true;
      releaseHistory();
    }
  };

  await page.route("**/api/candles?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("interval") !== "1s" || heldHistory) {
      await route.continue();
      return;
    }

    const response = await request.get(route.request().url());
    heldHistory = {
      body: await response.text(),
      status: response.status(),
      headers: await response.headers(),
    };
    await holdHistory;
    await route.fulfill(heldHistory).catch(() => undefined);
  });

  try {
    await chart.getByRole("radio", { name: "1s" }).click();
    await expect(chart.getByText("Loading 1s history")).toBeVisible();
    const legendUTC = chart
      .locator(".legend-cell")
      .filter({ has: page.getByText("UTC", { exact: true }) })
      .locator("strong");
    await expect
      .poll(async () => (await legendUTC.textContent())?.trim() ?? "", { timeout: 20_000 })
      .not.toBe("-");

    releaseHeldHistory();
    await expect(chart.getByText("Loading 1s history")).toBeHidden({ timeout: 20_000 });
    expect(heldHistory).not.toBeNull();

    const history = JSON.parse(heldHistory!.body) as {
      candles: Array<{ t: number }>;
    };
    expect(history.candles.length).toBeGreaterThan(40);
    expect(typeof history.candles[0]?.t).toBe("number");
    const firstUTCs = new Set(history.candles.slice(0, 2).map((candle) => formatUTC(candle.t)));
    const interiorUTCs = new Set(history.candles.slice(20, -20).map((candle) => formatUTC(candle.t)));
    const latestUTC = formatUTC(history.candles[history.candles.length - 1]!.t);
    const frame = chart.locator(".chart-frame");
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(chart.getByText("Inspecting candle")).toBeVisible();
    const inspectedUTC = (await legendUTC.textContent())?.trim() ?? "";

    expect(firstUTCs.has(inspectedUTC)).toBe(false);
    expect(inspectedUTC).not.toBe(latestUTC);
    expect(interiorUTCs.has(inspectedUTC)).toBe(true);
  } finally {
    releaseHeldHistory();
    await page.unroute("**/api/candles?**").catch(() => undefined);
  }
});

test("keeps the interior history viewport after same-session reconnect", async ({ page, request }) => {
  await page.addInitScript(() => {
    type PendingFrame = { socket: WebSocket; data: string };
    const controlledWindow = window as Window & {
      __spacktStartReconnectCandleBuffer?: () => void;
      __spacktReleaseBufferedCandles?: () => void;
    };
    const NativeWebSocket = window.WebSocket;
    const pending: PendingFrame[] = [];
    let buffering = false;
    let released = false;

    controlledWindow.__spacktStartReconnectCandleBuffer = () => {
      pending.length = 0;
      buffering = true;
      released = false;
    };
    controlledWindow.__spacktReleaseBufferedCandles = () => {
      released = true;
      for (const frame of pending.splice(0)) {
        frame.socket.dispatchEvent(new MessageEvent("message", { data: frame.data }));
      }
    };

    window.WebSocket = class BufferedReconnectWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          if (
            buffering &&
            !released &&
            typeof event.data === "string" &&
            event.data.includes('"candles"') &&
            event.data.includes('"interval":"1m"')
          ) {
            event.stopImmediatePropagation();
            pending.push({ socket: this, data: event.data });
          }
        }, true);
      }
    };
  });

  await gotoMarket(page);

  const chart = region(page, "Candlestick chart");
  const status = region(page, "Connection and delivery");
  await expect(status.getByText("Live")).toBeVisible({ timeout: 20_000 });
  await expect(chart.getByRole("radio", { name: "1m" })).toHaveAttribute("aria-checked", "true");
  await expect(chart.getByText("Loading 1m history")).toBeHidden({ timeout: 20_000 });
  await chart.getByRole("radio", { name: "5m" }).click();
  await expect(chart.getByRole("radio", { name: "5m" })).toHaveAttribute("aria-checked", "true");
  await expect(chart.getByText("Loading 5m history")).toBeHidden({ timeout: 20_000 });
  await chart.getByRole("radio", { name: "1s" }).click();
  await expect(chart.getByRole("radio", { name: "1s" })).toHaveAttribute("aria-checked", "true");
  await expect(chart.getByText("Loading 1s history")).toBeHidden({ timeout: 20_000 });
  await chart.getByRole("radio", { name: "1m" }).click();
  await expect(chart.getByRole("radio", { name: "1m" })).toHaveAttribute("aria-checked", "true");
  await expect(chart.getByText("Loading 1m history")).toBeHidden({ timeout: 20_000 });

  const legendUTC = chart
    .locator(".legend-cell")
    .filter({ has: page.getByText("UTC", { exact: true }) })
    .locator("strong");
  const legendClose = chart
    .locator(".legend-cell")
    .filter({ has: page.getByText("C", { exact: true }) })
    .locator("strong");
  await expect
    .poll(async () => (await legendUTC.textContent())?.trim() ?? "", { timeout: 20_000 })
    .not.toBe("-");
  await expect(legendClose).toHaveText(moneyText, { timeout: 20_000 });

  let releaseHistory!: () => void;
  const holdHistory = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let heldHistory: {
    body: string;
    status: number;
    headers: Record<string, string>;
  } | null = null;
  let releaseResult: "pending" | "fulfilled" | "aborted" = "pending";
  let historyReleased = false;
  const releaseHeldHistory = () => {
    if (!historyReleased) {
      historyReleased = true;
      releaseHistory();
    }
  };
  const releaseBufferedCandles = async () => {
    await page.evaluate(() => {
      const controlledWindow = window as Window & {
        __spacktReleaseBufferedCandles?: () => void;
      };
      controlledWindow.__spacktReleaseBufferedCandles?.();
    });
  };

  await page.route("**/api/candles?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("interval") !== "1m" || heldHistory) {
      await route.continue();
      return;
    }

    const response = await request.get(route.request().url());
    heldHistory = {
      body: await response.text(),
      status: response.status(),
      headers: await response.headers(),
    };
    await holdHistory;
    try {
      await route.fulfill(heldHistory);
      releaseResult = "fulfilled";
    } catch {
      releaseResult = "aborted";
    }
  });

  try {
    const panel = await diagnostics(page);
    await page.evaluate(() => {
      const controlledWindow = window as Window & {
        __spacktStartReconnectCandleBuffer?: () => void;
      };
      controlledWindow.__spacktStartReconnectCandleBuffer?.();
    });
    await panel.getByRole("button", { name: "Disconnect this session" }).click();
    await panel.getByRole("button", { name: "Close diagnostics" }).click();
    await expect(panel).toBeHidden();

    await expect(chart.getByText("Loading 1m history")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => heldHistory !== null, { timeout: 20_000 }).toBe(true);
    await expect(legendUTC).toHaveText("-", { timeout: 20_000 });

    await releaseBufferedCandles();
    await expect(legendUTC).toHaveText(/\d{2}:\d{2}:\d{2}/, { timeout: 20_000 });
    await expect(legendClose).toHaveText(moneyText, { timeout: 20_000 });
    await expect(chart.getByText("Loading 1m history")).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    releaseHeldHistory();
    await expect
      .poll(() => releaseResult, { timeout: 20_000 })
      .toBe("fulfilled");
    await expect(chart.getByText("Loading 1m history")).toBeHidden({ timeout: 20_000 });
    expect(heldHistory).not.toBeNull();

    const history = JSON.parse(heldHistory!.body) as {
      candles: Array<{ t: number }>;
    };
    expect(history.candles.length).toBeGreaterThan(40);
    expect(typeof history.candles[0]?.t).toBe("number");
    const firstUTCs = new Set(history.candles.slice(0, 2).map((candle) => formatUTC(candle.t)));
    const interiorUTCs = new Set(history.candles.slice(20, -20).map((candle) => formatUTC(candle.t)));
    const latestUTC = formatUTC(history.candles[history.candles.length - 1]!.t);
    const frame = chart.locator(".chart-frame");
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(chart.getByText("Inspecting candle")).toBeVisible();
    const inspectedUTC = (await legendUTC.textContent())?.trim() ?? "";

    expect(firstUTCs.has(inspectedUTC)).toBe(false);
    expect(inspectedUTC).not.toBe(latestUTC);
    expect(interiorUTCs.has(inspectedUTC)).toBe(true);
  } finally {
    await releaseBufferedCandles().catch(() => undefined);
    releaseHeldHistory();
    await page.unroute("**/api/candles?**").catch(() => undefined);
  }
});

test("traps diagnostics focus and returns it on Escape", async ({ page }) => {
  await gotoMarket(page);

  const trigger = page.getByRole("button", { name: "Open diagnostics" });
  await trigger.click();

  const dialog = page.getByRole("dialog", {
    name: "Diagnostics and debug controls",
  });
  await expect(dialog).toBeVisible();

  const closeButton = dialog.getByRole("button", { name: "Close diagnostics" });
  await closeButton.focus();
  await expect(closeButton).toBeFocused();

  await expect
    .poll(async () => activeElementIsInside(dialog))
    .toBe(true);

  await page.keyboard.press("Tab");
  await expect.poll(async () => activeElementIsInside(dialog)).toBe(true);

  await closeButton.focus();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(async () => activeElementIsInside(dialog)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
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
  await expect(
    chart
      .locator(".legend-cell")
      .filter({ has: page.getByText("C", { exact: true }) })
      .locator("strong"),
  ).toHaveText(moneyText, { timeout: 20_000 });

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
  await expect.poll(async () => (await status.textContent()) ?? "").toMatch(/Live/);
  await expect
    .poll(async () => (await status.textContent()) ?? "", { timeout: 20_000 })
    .toMatch(/RTT[\s\S]*\d+(?:\.\d+)?\s*ms/);
  await expect
    .poll(async () => (await status.textContent()) ?? "", { timeout: 20_000 })
    .toMatch(/Observed[\s\S]*\d+(?:\.\d+)?\s*\/s/);

  const panel = await diagnostics(page);
  await expect(panel.getByText(/Configured target|Target/)).toBeVisible();
  await expect(panel.getByText(/Observed/)).toBeVisible();
  await expect(panel.getByText(/over \d+(?:\.\d+)? s|-/)).toBeVisible();
});

test("forces each delivery tier and returns to auto", async ({ page }) => {
  await gotoMarket(page);
  await expect(region(page, "Connection and delivery").getByText("Live")).toBeVisible({
    timeout: 20_000,
  });
  const panel = await diagnostics(page);

  await forceTier(panel, "Full");
  await expect(panel.getByText(/Forced full\. Auto would be/)).toBeVisible();
  await expectTierSelected(panel, "Full");
  await page.waitForTimeout(1_050);

  await forceTier(panel, "Degraded");
  await expect(panel.getByText(/Forced degraded\. Auto would be/)).toBeVisible();
  await expectTierSelected(panel, "Degraded");
  await page.waitForTimeout(1_050);

  await forceTier(panel, "Minimal");
  await expect(panel.getByText(/Forced minimal\. Auto would be/)).toBeVisible();
  await expectTierSelected(panel, "Minimal");
  await expect(panel.getByText(/Configured target|Target/)).toBeVisible();
  await expect(panel.getByText(/Observed/)).toBeVisible();
  await page.waitForTimeout(1_050);

  await forceTier(panel, "Auto");
  await expectTierSelected(panel, "Auto");
  await expect(panel.getByText(/Forced (full|degraded|minimal)\. Auto would be/)).toBeHidden();
});

test("shows cached stale data after disconnect and recovers", async ({ page, request }) => {
  await installWebSocketObserver(page);
  await gotoMarket(page);

  const summary = region(page, "Market summary");
  const status = region(page, "Connection and delivery");
  const latestPrice = summary.getByLabel("Latest price");
  await expectTextContent(latestPrice, moneyText);
  const openBaseline = await socketEventCount(page, "open");
  const closeBaseline = await socketEventCount(page, "close");
  let releaseSnapshot!: () => void;
  const holdReplacementSnapshot = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  const replacementSnapshot = page.waitForRequest((request) =>
    request.url().startsWith(`${backendURL}/api/book`),
  );
  let heldReplacementSnapshot = false;
  await page.route("**/api/book", async (route) => {
    if (heldReplacementSnapshot) {
      await route.continue();
      return;
    }

    heldReplacementSnapshot = true;
    const response = await request.get(`${backendURL}/api/book`);
    const body = await response.text();
    await holdReplacementSnapshot;
    await route
      .fulfill({
        status: response.status(),
        headers: await response.headers(),
        body,
      })
      .catch(() => undefined);
  });

  const panel = await diagnostics(page);
  await panel.getByRole("button", { name: "Disconnect this session" }).click();
  await panel.getByRole("button", { name: "Close diagnostics" }).click();
  await expect(panel).toBeHidden();

  await expect
    .poll(async () => socketEventCount(page, "close"))
    .toBeGreaterThan(closeBaseline);
  const cachedPrice = await socketCloseLatestPrice(page, closeBaseline);
  expect(cachedPrice).toMatch(moneyText);
  await replacementSnapshot;
  await expect(status.locator("strong").first()).toHaveText(/Stale|Reconnecting/);
  await expect(status.locator("strong").first()).not.toHaveText("Live");
  await expectTextContent(latestPrice, moneyText);
  releaseSnapshot();
  await page.unroute("**/api/book");
  await expect
    .poll(async () => socketEventCount(page, "open"))
    .toBeGreaterThan(openBaseline);
  await expect(region(page, "Connection and delivery").getByText(/Live/)).toBeVisible({
    timeout: 20_000,
  });
});

test("shows book gap recovery without clearing cached rows", async ({ page }) => {
  await gotoMarket(page);

  const book = region(page, "Order book");
  await expect(book.getByText(/^ASK$/)).toHaveCount(10);
  await expect(book.getByText(/^BID$/)).toHaveCount(10);

  const replacementSnapshot = page.waitForRequest((request) =>
    request.url().startsWith(`${backendURL}/api/book`),
  );
  await page.route("**/api/book", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.continue();
  });

  const panel = await diagnostics(page);
  await panel.getByRole("button", { name: "Drop next book delta" }).click();
  await panel.getByRole("button", { name: "Close diagnostics" }).click();
  await expect(panel).toBeHidden();

  await replacementSnapshot;
  await expect(
    book.getByText(/Gap detected\. Fetching snapshot\.|Book resyncing/).first(),
  ).toBeVisible();
  await expect(book.getByText(/^ASK$/)).toHaveCount(10);
  await expect(book.getByText(/^BID$/)).toHaveCount(10);
  await expect(book.getByText(/synced/i)).toBeVisible({ timeout: 20_000 });
  await page.unroute("**/api/book");
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
