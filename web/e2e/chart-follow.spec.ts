import { expect, type Locator, type Page, test } from "@playwright/test";

type CandleBody = {
  x: number;
  y: number;
  width: number;
  height: number;
  color: "green" | "red";
};

type BodyStats = {
  bodies: CandleBody[];
  medianWidth: number;
  rightmost: CandleBody;
  plotRight: number;
};

async function gotoMarket(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("main", { name: "SpacKt market console" }),
  ).toBeVisible();
}

function region(page: Page, name: string) {
  return page.getByRole("region", { name });
}

function chart(page: Page) {
  return region(page, "Candlestick chart");
}

function chartLocalTime(page: Page) {
  return chart(page)
    .locator(".legend-cell")
    .filter({ has: page.getByText("Local time", { exact: true }) })
    .locator("strong");
}

function chartFrame(page: Page) {
  return chart(page).locator(".chart-frame");
}

async function waitForLiveChart(page: Page) {
  await expect(region(page, "Connection and delivery").getByText("Live")).toBeVisible({
    timeout: 20_000,
  });
  await expect(chart(page).getByText("Loading 1m history")).toBeHidden({
    timeout: 20_000,
  });
  await expect(chartLocalTime(page)).toHaveText(/\d{2}:\d{2}:\d{2}/, {
    timeout: 20_000,
  });
  await expect(chart(page).getByText("Chart unavailable")).toBeHidden();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function selectInterval(page: Page, interval: "1s" | "1m" | "5m") {
  const panel = chart(page);
  await panel.getByRole("radio", { name: interval }).click();
  await expect(panel.getByRole("radio", { name: interval })).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByText(`Loading ${interval} history`)).toBeHidden({ timeout: 20_000 });
  await expect(chartLocalTime(page)).toHaveText(/\d{2}:\d{2}:\d{2}/, { timeout: 20_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitForLocalTimeAdvance(page: Page, minimumSeconds: number) {
  const before = await currentLocalSeconds(page);
  await expect
    .poll(async () => localDelta(await currentLocalSeconds(page), before), {
      timeout: Math.max(20_000, (minimumSeconds + 10) * 1_000),
    })
    .toBeGreaterThanOrEqual(minimumSeconds);
}

async function waitForLiveEdgeAdvance(page: Page, minimumSeconds: number) {
  await waitForLocalTimeAdvance(page, minimumSeconds);
  const box = await chartFrame(page).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x - 20, box!.y - 20);
  const currentLatest = await currentLocalSeconds(page);
  await expectReadableBodiesAtLiveEdge(page);
  const rightmost = await hoverRightmostVisibleCandle(page);
  expect(localDistanceSeconds(rightmost, currentLatest)).toBeLessThanOrEqual(2);
}

async function currentLocalSeconds(page: Page) {
  const text = ((await chartLocalTime(page).textContent()) ?? "").trim();
  return parseLocalSeconds(text);
}

function parseLocalSeconds(text: string) {
  const match = text.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  expect(match).not.toBeNull();
  return Number(match![1]) * 3_600 + Number(match![2]) * 60 + Number(match![3]);
}

function localDelta(next: number, previous: number) {
  const delta = next - previous;
  return delta >= 0 ? delta : delta + 24 * 3_600;
}

function localAgeSeconds(older: number, newer: number) {
  return localDelta(newer, older);
}

function localDistanceSeconds(left: number, right: number) {
  return Math.min(localDelta(left, right), localDelta(right, left));
}

async function hoverRightmostVisibleCandle(page: Page) {
  const plot = await mainPlotBox(page);
  await page.mouse.move(plot.x - 20, plot.y - 20);
  await expect(chart(page).getByText("Latest candle")).toBeVisible();
  const yFractions = [0.5, 0.35, 0.65, 0.25, 0.75];
  for (let x = plot.x + plot.width - 18; x >= plot.x + 12; x -= 4) {
    for (const yFraction of yFractions) {
      await page.mouse.move(x, plot.y + plot.height * yFraction);
      if (await chart(page).getByText("Inspecting candle").isVisible().catch(() => false)) {
        const text = ((await chartLocalTime(page).textContent()) ?? "").trim();
        return parseLocalSeconds(text);
      }
    }
  }
  await expect(chart(page).getByText("Inspecting candle")).toBeVisible();
  const text = ((await chartLocalTime(page).textContent()) ?? "").trim();
  return parseLocalSeconds(text);
}

async function mainPlotBox(page: Page) {
  return chartFrame(page).evaluate((root) => {
    const frame = root.getBoundingClientRect();
    const canvases = Array.from(root.querySelectorAll("canvas"))
      .map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return {
          x: rect.left - frame.left,
          y: rect.top - frame.top,
          width: rect.width,
          height: rect.height,
          area: rect.width * rect.height,
        };
      })
      .filter((rect) => rect.width > 100 && rect.height > 100)
      .sort((left, right) => right.area - left.area);
    const plot = canvases[0];
    if (!plot) throw new Error("main chart canvas not found");
    return {
      x: frame.left + plot.x,
      y: frame.top + plot.y,
      width: plot.width,
      height: plot.height,
    };
  });
}

async function dragMainPlot(page: Page, fromFraction: number, toFraction: number) {
  const plot = await mainPlotBox(page);
  const y = plot.y + plot.height / 2;
  await page.mouse.move(plot.x + plot.width * fromFraction, y);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * toFraction, y, { steps: 8 });
  await page.mouse.up();
}

async function candleBodyStats(frame: Locator): Promise<BodyStats> {
  const stats = await frame.evaluate((root) => {
    type RawBody = {
      x: number;
      y: number;
      width: number;
      height: number;
      color: "green" | "red";
    };

    const targetColors = new Map<string, "green" | "red">([
      ["111,214,167", "green"],
      ["255,122,122", "red"],
    ]);
    const frameRect = root.getBoundingClientRect();
    const canvases = Array.from(root.querySelectorAll("canvas"))
      .map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > frameRect.width * 0.5 && rect.height > frameRect.height * 0.5);
    const plotRight = canvases.reduce(
      (right, { rect }) => Math.max(right, rect.left - frameRect.left + rect.width),
      0,
    );
    const bodies: RawBody[] = [];

    for (const { canvas, rect } of canvases) {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) continue;

      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const visited = new Uint8Array(canvas.width * canvas.height);
      const colorAt = (x: number, y: number) => {
        const offset = (y * canvas.width + x) * 4;
        if (image.data[offset + 3] === 0) return null;
        return targetColors.get(`${image.data[offset]},${image.data[offset + 1]},${image.data[offset + 2]}`) ?? null;
      };

      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const index = y * canvas.width + x;
          if (visited[index]) continue;

          const color = colorAt(x, y);
          if (!color) {
            visited[index] = 1;
            continue;
          }

          const stack: Array<[number, number]> = [[x, y]];
          visited[index] = 1;
          let minX = x;
          let maxX = x;
          let minY = y;
          let maxY = y;
          let pixels = 0;

          while (stack.length > 0) {
            const [cx, cy] = stack.pop()!;
            pixels += 1;
            minX = Math.min(minX, cx);
            maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy);
            maxY = Math.max(maxY, cy);

            for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
              if (nx < 0 || nx >= canvas.width || ny < 0 || ny >= canvas.height) continue;
              const nextIndex = ny * canvas.width + nx;
              if (visited[nextIndex] || colorAt(nx, ny) !== color) continue;
              visited[nextIndex] = 1;
              stack.push([nx, ny]);
            }
          }

          const cssWidth = (maxX - minX + 1) * rect.width / canvas.width;
          const cssHeight = (maxY - minY + 1) * rect.height / canvas.height;
          const cssX = rect.left - frameRect.left + minX * rect.width / canvas.width;
          const cssY = rect.top - frameRect.top + minY * rect.height / canvas.height;
          const cssPixels = pixels * rect.width * rect.height / (canvas.width * canvas.height);

          if (
            cssWidth >= 2.5 &&
            cssWidth <= 30 &&
            cssHeight >= 2 &&
            cssHeight <= rect.height * 0.8 &&
            cssPixels >= cssWidth * Math.min(cssHeight, 3) * 0.45
          ) {
            bodies.push({ x: cssX, y: cssY, width: cssWidth, height: cssHeight, color });
          }
        }
      }
    }

    const sorted = bodies.sort((left, right) => left.x - right.x);
    const widths = sorted.map((body) => body.width).sort((left, right) => left - right);
    const medianWidth = widths.length > 0 ? widths[Math.floor(widths.length / 2)] : 0;
    const rightmost = sorted.at(-1) ?? null;

    return {
      bodies: sorted,
      medianWidth,
      rightmost,
      plotRight,
    };
  });

  expect(stats.rightmost, "chart must render measurable candle bodies").not.toBeNull();
  expect(stats.bodies.length, "chart must render several candle bodies").toBeGreaterThan(12);
  return stats as BodyStats;
}

async function expectReadableBodiesAtLiveEdge(page: Page) {
  const stats = await candleBodyStats(chartFrame(page));
  expect(stats.medianWidth, "median candle body width should match the readable default spacing").toBeGreaterThanOrEqual(6);
  expect(stats.rightmost.x + stats.rightmost.width, "rightmost candle body should stay near the live edge").toBeGreaterThan(
    stats.plotRight - 96,
  );
  expect(stats.rightmost.x + stats.rightmost.width, "rightmost candle body should not be clipped off the right edge").toBeLessThanOrEqual(
    stats.plotRight - 4,
  );
  return stats;
}

test("keeps the newest 1s candle visible at the live edge while idle", async ({ page }) => {
  await gotoMarket(page);
  await selectInterval(page, "1s");

  await waitForLiveEdgeAdvance(page, 5);
});

test("keeps default candle bodies readable on each interval", async ({ page }) => {
  await gotoMarket(page);
  await waitForLiveChart(page);

  for (const interval of ["1s", "1m", "5m"] as const) {
    await selectInterval(page, interval);
    const stats = await candleBodyStats(chartFrame(page));
    expect(stats.medianWidth, `${interval} candle bodies should be readable by default`).toBeGreaterThanOrEqual(6);
  }
});

test("pauses follow on manual pan and returns to the live edge with Go Live", async ({ page }) => {
  await gotoMarket(page);
  await selectInterval(page, "1s");
  await candleBodyStats(chartFrame(page));
  const latestBeforePan = await currentLocalSeconds(page);

  await dragMainPlot(page, 0.45, 0.8);

  await expect(chart(page).getByRole("button", { name: "Go Live" })).toBeVisible();
  const rightmostAfterPan = await hoverRightmostVisibleCandle(page);
  expect(localAgeSeconds(rightmostAfterPan, latestBeforePan)).toBeGreaterThanOrEqual(3);

  await chart(page).getByRole("button", { name: "Go Live" }).click();

  await expect(chart(page).getByRole("button", { name: "Go Live" })).toBeHidden();
  await expectReadableBodiesAtLiveEdge(page);
  const currentLatest = await currentLocalSeconds(page);
  expect(localAgeSeconds(rightmostAfterPan, currentLatest)).toBeGreaterThanOrEqual(3);
});

test("reattaches follow when the user pans back to the live edge", async ({ page }) => {
  await gotoMarket(page);
  await selectInterval(page, "1s");
  await expectReadableBodiesAtLiveEdge(page);

  const frameBox = await chartFrame(page).boundingBox();
  expect(frameBox).not.toBeNull();
  await dragMainPlot(page, 0.45, 0.8);
  await expect(chart(page).getByRole("button", { name: "Go Live" })).toBeVisible();

  await dragMainPlot(page, 0.8, 0.42);
  await page.mouse.move(frameBox!.x - 20, frameBox!.y - 20);

  await expect(chart(page).getByRole("button", { name: "Go Live" })).toBeHidden();
  await waitForLiveEdgeAdvance(page, 5);
});

test("keeps manual wheel zoom candle width after changing interval", async ({ page }) => {
  await gotoMarket(page);
  await selectInterval(page, "1s");

  const box = await chartFrame(page).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -900);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const zoomed = await candleBodyStats(chartFrame(page));
  expect(zoomed.medianWidth, "wheel zoom must visibly change candle width before interval switch").toBeGreaterThanOrEqual(9);

  await selectInterval(page, "5m");
  const afterSwitch = await candleBodyStats(chartFrame(page));

  expect(Math.abs(afterSwitch.medianWidth - zoomed.medianWidth)).toBeLessThanOrEqual(2);
});
