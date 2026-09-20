import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../domain/model";
import { mountCandleChart } from "./adapter";

const chartPort = vi.hoisted(() => {
  type CrosshairHandler = (param: {
    point?: { x: number; y: number };
    time?: number;
    seriesData: Map<object, unknown>;
  }) => void;

  const CandlestickSeries = Symbol("CandlestickSeries");
  const series = {
    setData: vi.fn(),
    update: vi.fn(),
  };
  const timeScale = {
    fitContent: vi.fn(),
    getVisibleLogicalRange: vi.fn(),
    setVisibleLogicalRange: vi.fn(),
    subscribeVisibleLogicalRangeChange: vi.fn((handler: (range: { from: number; to: number } | null) => void) => {
      chartPort.activeRangeHandler = handler;
    }),
    unsubscribeVisibleLogicalRangeChange: vi.fn((handler: (range: { from: number; to: number } | null) => void) => {
      if (chartPort.activeRangeHandler === handler) {
        chartPort.activeRangeHandler = undefined;
      }
    }),
    scrollPosition: vi.fn(),
    scrollToPosition: vi.fn(),
    options: vi.fn(() => ({ barSpacing: 12 })),
  };
  const chart = {
    addSeries: vi.fn(() => series),
    subscribeCrosshairMove: vi.fn((handler: CrosshairHandler) => {
      chartPort.activeCrosshairHandler = handler;
      chartPort.lastCrosshairHandler = handler;
    }),
    unsubscribeCrosshairMove: vi.fn((handler: CrosshairHandler) => {
      if (chartPort.activeCrosshairHandler === handler) {
        chartPort.activeCrosshairHandler = undefined;
      }
    }),
    setCrosshairPosition: vi.fn(),
    clearCrosshairPosition: vi.fn(),
    remove: vi.fn(),
    timeScale: vi.fn(() => timeScale),
  };
  const createChart = vi.fn(() => chart);

  return {
    CandlestickSeries,
    activeCrosshairHandler: undefined as CrosshairHandler | undefined,
    activeRangeHandler: undefined as ((range: { from: number; to: number } | null) => void) | undefined,
    lastCrosshairHandler: undefined as CrosshairHandler | undefined,
    chart,
    createChart,
    series,
    timeScale,
    reset() {
      createChart.mockClear();
      chart.addSeries.mockClear();
      chart.subscribeCrosshairMove.mockClear();
      chart.unsubscribeCrosshairMove.mockClear();
      chart.setCrosshairPosition.mockClear();
      chart.clearCrosshairPosition.mockClear();
      chart.remove.mockClear();
      chart.timeScale.mockClear();
      series.setData.mockClear();
      series.update.mockClear();
      timeScale.fitContent.mockClear();
      timeScale.getVisibleLogicalRange.mockReset();
      timeScale.setVisibleLogicalRange.mockClear();
      timeScale.subscribeVisibleLogicalRangeChange.mockClear();
      timeScale.unsubscribeVisibleLogicalRangeChange.mockClear();
      timeScale.scrollPosition.mockReset();
      timeScale.scrollToPosition.mockClear();
      timeScale.options.mockClear();
      timeScale.options.mockReturnValue({ barSpacing: 12 });
      this.activeCrosshairHandler = undefined;
      this.activeRangeHandler = undefined;
      this.lastCrosshairHandler = undefined;
    },
  };
});

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: chartPort.CandlestickSeries,
  createChart: chartPort.createChart,
}));

const container = {} as HTMLElement;

function candle(timeMs: number, rev = 1, closeTicks = 10_050, overrides: Partial<Candle> = {}): Candle {
  return {
    timeMs,
    openTicks: overrides.openTicks ?? closeTicks - 50,
    highTicks: overrides.highTicks ?? closeTicks + 75,
    lowTicks: overrides.lowTicks ?? closeTicks - 125,
    closeTicks,
    volumeLots: overrides.volumeLots ?? 12_345,
    rev,
    closed: overrides.closed ?? false,
  };
}

function mounted(onInspect = vi.fn(), onFollowingChange = vi.fn(), initialBarSpacing?: number) {
  return mountCandleChart(container, { onInspect, onFollowingChange, initialBarSpacing });
}

function createdChartOptions(): { timeScale?: { minBarSpacing?: number } } {
  const call = chartPort.createChart.mock.calls[0] as unknown as [HTMLElement, { timeScale?: { minBarSpacing?: number } }?] | undefined;
  expect(call).toBeDefined();
  return call?.[1] ?? {};
}

const resetReady = { reset: true } as const;

function crosshair(timeSeconds: number, data: unknown = {}): void {
  chartPort.activeCrosshairHandler?.({
    point: { x: 4, y: 8 },
    time: timeSeconds,
    seriesData: new Map([[chartPort.series, data]]),
  });
}

describe("mountCandleChart", () => {
  beforeEach(() => {
    chartPort.reset();
  });

  it("creates a v5 candlestick series with two-decimal price formatting", () => {
    mounted();

    expect(chartPort.createChart).toHaveBeenCalledWith(container, expect.any(Object));
    expect(chartPort.chart.addSeries).toHaveBeenCalledWith(
      chartPort.CandlestickSeries,
      expect.objectContaining({
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      }),
    );
  });

  it("uses readable live-edge time scale defaults without limiting native zoom-out", () => {
    const adapter = mounted();

    adapter.setCandles(Array.from({ length: 120 }, (_value, index) => candle((index + 1) * 1_000)), resetReady);

    expect(chartPort.createChart).toHaveBeenCalledWith(
      container,
      expect.objectContaining({
        timeScale: expect.objectContaining({
          barSpacing: 12,
          rightOffset: 3,
        }),
      }),
    );
    expect(createdChartOptions().timeScale?.minBarSpacing).toBeUndefined();
    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(3, false);
  });

  it("uses the provided initial bar spacing when mounting after an interval change", () => {
    mounted(vi.fn(), vi.fn(), 18);

    expect(chartPort.createChart).toHaveBeenCalledWith(
      container,
      expect.objectContaining({
        timeScale: expect.objectContaining({
          barSpacing: 18,
          rightOffset: 3,
        }),
      }),
    );
  });

  it("appends the newest candle without snapping to the Go Live offset", () => {
    const adapter = mounted();
    chartPort.timeScale.scrollPosition.mockReturnValue(1.5);
    adapter.setCandles([candle(1_000), candle(2_000)], resetReady);
    chartPort.series.update.mockClear();
    chartPort.timeScale.scrollToPosition.mockClear();

    adapter.setCandles([candle(1_000), candle(2_000), candle(3_000)]);

    expect(chartPort.series.update).toHaveBeenCalledWith(expect.objectContaining({ time: 3 }));
    expect(chartPort.timeScale.scrollToPosition).not.toHaveBeenCalledWith(3, false);
  });

  it("keeps the live right offset after a bulk replacement while following", () => {
    const adapter = mounted();
    const visibleRange = { from: 80, to: 120.5 };
    chartPort.timeScale.scrollPosition.mockReturnValue(1.5);
    const initial = Array.from({ length: 120 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_000 + index));
    const replacement = [
      ...Array.from({ length: 120 }, (_value, index) => candle((index + 1) * 1_000, 2, 10_500 + index)),
      candle(121_000, 1, 10_900),
    ];
    adapter.setCandles(initial, resetReady);
    chartPort.timeScale.getVisibleLogicalRange.mockReturnValue(visibleRange);
    chartPort.series.setData.mockClear();
    chartPort.timeScale.setVisibleLogicalRange.mockClear();
    chartPort.timeScale.scrollToPosition.mockClear();

    adapter.setCandles(replacement);

    expect(chartPort.series.setData).toHaveBeenCalled();
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(1.5, false);
    expect(chartPort.timeScale.setVisibleLogicalRange).not.toHaveBeenCalledWith(visibleRange);
  });

  it("does not pause follow mode for its own live-edge scroll updates", () => {
    const onFollowingChange = vi.fn();
    const adapter = mounted(vi.fn(), onFollowingChange);
    chartPort.timeScale.scrollPosition.mockReturnValue(3);

    adapter.setCandles([candle(1_000), candle(2_000)], resetReady);
    chartPort.activeRangeHandler?.({ from: 0, to: 1 });
    adapter.setCandles([candle(1_000), candle(2_000), candle(3_000)]);

    expect(onFollowingChange).not.toHaveBeenCalledWith(false);
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(3, false);
  });

  it("does not pause follow mode when positive right margin still leaves the latest candle visible", () => {
    const onFollowingChange = vi.fn();
    const adapter = mounted(vi.fn(), onFollowingChange);
    chartPort.timeScale.scrollPosition.mockReturnValue(5);
    adapter.setCandles([candle(1_000), candle(2_000), candle(3_000)], resetReady);
    chartPort.timeScale.scrollToPosition.mockClear();

    chartPort.activeRangeHandler?.({ from: 0, to: 3.5 });
    adapter.setCandles([candle(1_000), candle(2_000), candle(3_000), candle(4_000)]);

    expect(onFollowingChange).not.toHaveBeenCalledWith(false);
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(5, false);
  });

  it("pauses follow mode when the user pans into history", () => {
    const onFollowingChange = vi.fn();
    const adapter = mounted(vi.fn(), onFollowingChange);
    chartPort.timeScale.scrollPosition.mockReturnValue(-60);
    adapter.setCandles([candle(1_000), candle(2_000), candle(3_000)], resetReady);
    chartPort.timeScale.scrollToPosition.mockClear();

    chartPort.activeRangeHandler?.({ from: -60, to: -1 });
    adapter.setCandles([candle(1_000), candle(2_000), candle(3_000), candle(4_000)]);

    expect(onFollowingChange).toHaveBeenCalledWith(false);
    expect(chartPort.timeScale.scrollToPosition).not.toHaveBeenCalled();
  });

  it("resumes follow mode at the live edge without changing the chosen zoom", () => {
    const onFollowingChange = vi.fn();
    const adapter = mounted(vi.fn(), onFollowingChange);
    chartPort.timeScale.options.mockReturnValue({ barSpacing: 18 });
    chartPort.timeScale.scrollPosition.mockReturnValue(-1);
    adapter.setCandles([candle(1_000), candle(2_000), candle(3_000)], resetReady);
    chartPort.activeRangeHandler?.({ from: -2, to: -1 });
    chartPort.timeScale.scrollToPosition.mockClear();
    onFollowingChange.mockClear();

    adapter.followLive();

    expect(adapter.getBarSpacing()).toBe(18);
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(3, false);
    expect(onFollowingChange).toHaveBeenLastCalledWith(true);
  });

  it("converts domain milliseconds and ticks only at the chart edge", () => {
    const adapter = mounted();
    const first = candle(1_700_000_000_000, 3, 10_125, {
      openTicks: 10_000,
      highTicks: 10_250,
      lowTicks: 9_975,
    });

    adapter.setCandles([first], resetReady);

    expect(chartPort.series.setData).toHaveBeenCalledWith([
      { time: 1_700_000_000, open: 100, high: 102.5, low: 99.75, close: 101.25 },
    ]);
    expect(first).toEqual(candle(1_700_000_000_000, 3, 10_125, {
      openTicks: 10_000,
      highTicks: 10_250,
      lowTicks: 9_975,
    }));
  });

  it("passes first sorted history to setData", () => {
    const adapter = mounted();

    adapter.setCandles([candle(1_000), candle(2_000), candle(3_000)], resetReady);

    expect(chartPort.series.setData.mock.calls[0][0].map((bar: { time: number }) => bar.time)).toEqual([1, 2, 3]);
  });

  it("uses explicit reset to replace sorted history", () => {
    const adapter = mounted();
    adapter.setCandles([candle(1_000)], resetReady);
    chartPort.series.setData.mockClear();

    adapter.setCandles([candle(4_000), candle(5_000)], resetReady);

    expect(chartPort.series.setData).toHaveBeenCalledWith([
      expect.objectContaining({ time: 4 }),
      expect.objectContaining({ time: 5 }),
    ]);
  });

  it("does not duplicate chart updates for unchanged candle data", () => {
    const adapter = mounted();
    const current = candle(1_000, 1, 10_000);
    adapter.setCandles([current], resetReady);
    chartPort.series.setData.mockClear();
    chartPort.series.update.mockClear();

    adapter.setCandles([current]);

    expect(chartPort.series.setData).not.toHaveBeenCalled();
    expect(chartPort.series.update).not.toHaveBeenCalled();
  });

  it("updates the current candle incrementally", () => {
    const adapter = mounted();
    adapter.setCandles([candle(1_000, 1, 10_000)], resetReady);
    chartPort.series.update.mockClear();

    adapter.setCandles([candle(1_000, 2, 10_050)]);

    expect(chartPort.series.update).toHaveBeenCalledWith(
      expect.objectContaining({ time: 1, close: 100.5 }),
    );
  });

  it("updates a new later candle incrementally", () => {
    const adapter = mounted();
    adapter.setCandles([candle(1_000, 1, 10_000)], resetReady);
    chartPort.series.update.mockClear();

    adapter.setCandles([candle(1_000, 1, 10_000), candle(2_000, 1, 10_125)]);

    expect(chartPort.series.update).toHaveBeenCalledWith(
      expect.objectContaining({ time: 2, close: 101.25 }),
    );
  });

  it("applies an older correction as a historical update or a viewport-preserving replacement", () => {
    const adapter = mounted();
    const visibleRange = { from: 10, to: 20 };
    chartPort.timeScale.getVisibleLogicalRange.mockReturnValue(visibleRange);
    adapter.setCandles([candle(1_000, 1, 10_000), candle(2_000, 1, 10_100)], resetReady);
    chartPort.series.update.mockClear();
    chartPort.series.setData.mockClear();
    chartPort.timeScale.setVisibleLogicalRange.mockClear();

    adapter.setCandles([candle(1_000, 2, 10_050), candle(2_000, 1, 10_100)]);

    const historicalUpdate = chartPort.series.update.mock.calls.some(
      ([bar, historical]) => (bar as { time: number }).time === 1 && historical === true,
    );
    const safeReplacement = chartPort.series.setData.mock.calls.some(([bars]) =>
      (bars as Array<{ time: number; close: number }>).some((bar) => bar.time === 1 && bar.close === 100.5),
    )
      && chartPort.timeScale.setVisibleLogicalRange.mock.calls.some(([range]) => range === visibleRange);
    expect(historicalUpdate || safeReplacement).toBe(true);
  });

  it("replaces trimmed history while preserving the same visible candle times", () => {
    const adapter = mounted();
    const visibleRange = { from: 900, to: 1_000 };
    const initial = Array.from({ length: 1_000 }, (_value, index) => candle(index * 1_000, 1, 10_000 + index));
    const trimmed = Array.from({ length: 1_000 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_001 + index));
    adapter.setCandles(initial, resetReady);
    chartPort.timeScale.getVisibleLogicalRange.mockReturnValue(visibleRange);
    chartPort.series.setData.mockClear();

    adapter.setCandles(trimmed);

    expect(chartPort.series.setData).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ time: 1_000 })]),
    );
    expect(chartPort.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 899, to: 999 });
  });

  it("anchors initial reset at the live edge only once", () => {
    const adapter = mounted();

    adapter.setCandles([candle(1_000)], resetReady);
    adapter.setCandles([candle(1_000), candle(2_000)], resetReady);

    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenCalledTimes(1);
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(3, false);
  });

  it("anchors recovered history at the live edge after a live seed arrives before history", () => {
    const adapter = mounted();
    const seed = candle(361_000, 1, 10_500);
    const history = Array.from({ length: 361 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_000 + index));
    chartPort.timeScale.getVisibleLogicalRange.mockReturnValue({ from: -1, to: 0 });

    adapter.setCandles([seed], { reset: true, historyReady: false });
    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    chartPort.timeScale.fitContent.mockClear();
    chartPort.timeScale.setVisibleLogicalRange.mockClear();

    adapter.setCandles(history, { reset: false, historyReady: true });

    expect(chartPort.series.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ time: 1 }),
        expect.objectContaining({ time: 361 }),
      ]),
    );
    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(3, false);
    expect(chartPort.timeScale.setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it("anchors at the live edge when loading becomes ready with the same candle data", () => {
    const adapter = mounted();
    const seed = [candle(60_000, 1, 10_500)];

    adapter.setCandles(seed, { reset: true, historyReady: false });
    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    chartPort.timeScale.fitContent.mockClear();
    chartPort.timeScale.setVisibleLogicalRange.mockClear();

    adapter.setCandles(seed, { reset: false, historyReady: true });

    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(3, false);
    expect(chartPort.timeScale.setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it("restores the pre-clear user range after a loading seed clamps the chart", () => {
    const adapter = mounted();
    const firstHistory = Array.from({ length: 120 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_000 + index));
    const seed = candle(120_000, 2, 10_700);
    const recoveredHistory = firstHistory.map((item, index) => index === firstHistory.length - 1 ? seed : item);
    const userRange = { from: 80, to: 119 };
    const seedRange = { from: -1, to: 0 };
    let rangePhase: "before-clear" | "seed" = "before-clear";
    chartPort.timeScale.getVisibleLogicalRange.mockImplementation(() =>
      rangePhase === "before-clear" ? userRange : seedRange,
    );
    adapter.setCandles(firstHistory, resetReady);
    chartPort.timeScale.scrollPosition.mockReturnValue(-1);
    chartPort.activeRangeHandler?.({ from: 80, to: 119 });
    adapter.setCandles([], { reset: true, historyReady: false });
    rangePhase = "seed";
    adapter.setCandles([seed], { reset: true, historyReady: false });
    chartPort.timeScale.fitContent.mockClear();
    chartPort.timeScale.setVisibleLogicalRange.mockClear();

    adapter.setCandles(recoveredHistory, { reset: false, historyReady: true });

    expect(chartPort.series.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ time: 1 }),
        expect.objectContaining({ time: 120 }),
      ]),
    );
    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    expect(chartPort.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith(userRange);
  });

  it("restores the pre-clear user range when the same recovered history becomes ready", () => {
    const adapter = mounted();
    const firstHistory = Array.from({ length: 120 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_000 + index));
    const seed = candle(120_000, 2, 10_700);
    const recoveredHistory = firstHistory.map((item, index) => index === firstHistory.length - 1 ? seed : item);
    const userRange = { from: 80, to: 119 };
    const seedRange = { from: -1, to: 0 };
    let rangePhase: "before-clear" | "seed" = "before-clear";
    chartPort.timeScale.getVisibleLogicalRange.mockImplementation(() =>
      rangePhase === "before-clear" ? userRange : seedRange,
    );
    adapter.setCandles(firstHistory, resetReady);
    chartPort.timeScale.scrollPosition.mockReturnValue(-1);
    chartPort.activeRangeHandler?.({ from: 80, to: 119 });
    adapter.setCandles([], { reset: true, historyReady: false });
    rangePhase = "seed";
    adapter.setCandles([seed], { reset: true, historyReady: false });
    adapter.setCandles(recoveredHistory, { reset: false, historyReady: false });
    chartPort.timeScale.fitContent.mockClear();
    chartPort.timeScale.setVisibleLogicalRange.mockClear();

    adapter.setCandles(recoveredHistory, { reset: false, historyReady: true });

    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    expect(chartPort.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith(userRange);
  });

  it("restores manual history by the same candle times when recovery trims older bars", () => {
    const adapter = mounted();
    const firstHistory = Array.from({ length: 1_000 }, (_value, index) => candle(index * 1_000, 1, 10_000 + index));
    const seed = candle(999_000, 2, 11_200);
    const recoveredHistory = Array.from({ length: 500 }, (_value, index) => {
      const timeIndex = index + 500;
      return timeIndex === 999 ? seed : candle(timeIndex * 1_000, 1, 10_000 + timeIndex);
    });
    const userRange = { from: 900, to: 950 };
    const seedRange = { from: -1, to: 0 };
    let rangePhase: "before-clear" | "seed" = "before-clear";
    chartPort.timeScale.getVisibleLogicalRange.mockImplementation(() =>
      rangePhase === "before-clear" ? userRange : seedRange,
    );
    adapter.setCandles(firstHistory, resetReady);
    chartPort.timeScale.scrollPosition.mockReturnValue(-49);
    chartPort.activeRangeHandler?.(userRange);
    adapter.setCandles([], { reset: true, historyReady: false });
    rangePhase = "seed";
    adapter.setCandles([seed], { reset: true, historyReady: false });
    chartPort.timeScale.setVisibleLogicalRange.mockClear();

    adapter.setCandles(recoveredHistory, { reset: false, historyReady: true });

    expect(chartPort.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 400, to: 450 });
  });

  it("ignores transient pending-history range changes without pausing follow mode", () => {
    const onFollowingChange = vi.fn();
    const adapter = mounted(vi.fn(), onFollowingChange);
    const firstHistory = Array.from({ length: 120 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_000 + index));
    const seed = candle(120_000, 2, 10_700);
    const recoveredHistory = firstHistory.map((item, index) => index === firstHistory.length - 1 ? seed : item);
    chartPort.timeScale.scrollPosition.mockReturnValue(1.5);
    chartPort.timeScale.getVisibleLogicalRange.mockReturnValue({ from: 80, to: 120.5 });
    adapter.setCandles(firstHistory, resetReady);
    adapter.setCandles([], { reset: true, historyReady: false });
    chartPort.timeScale.scrollPosition.mockReturnValue(-1);
    chartPort.activeRangeHandler?.({ from: -1, to: 0 });
    chartPort.timeScale.scrollPosition.mockReturnValue(1.5);
    adapter.setCandles([seed], { reset: true, historyReady: false });
    chartPort.timeScale.setVisibleLogicalRange.mockClear();
    chartPort.timeScale.scrollToPosition.mockClear();
    onFollowingChange.mockClear();

    adapter.setCandles(recoveredHistory, { reset: false, historyReady: true });

    expect(onFollowingChange).not.toHaveBeenCalledWith(false);
    expect(chartPort.timeScale.setVisibleLogicalRange).not.toHaveBeenCalledWith({ from: -1, to: 0 });
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(1.5, false);
  });

  it("reconnects at the latest candle with the current zoom while follow mode is active", () => {
    const adapter = mounted();
    const firstHistory = Array.from({ length: 120 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_000 + index));
    const seed = candle(120_000, 2, 10_700);
    const recoveredHistory = firstHistory.map((item, index) => index === firstHistory.length - 1 ? seed : item);
    chartPort.timeScale.options.mockReturnValue({ barSpacing: 18 });
    chartPort.timeScale.scrollPosition.mockReturnValue(1.5);
    chartPort.timeScale.getVisibleLogicalRange.mockReturnValue({ from: 80, to: 120.5 });
    adapter.setCandles(firstHistory, resetReady);
    adapter.setCandles([], { reset: true, historyReady: false });
    adapter.setCandles([seed], { reset: true, historyReady: false });
    chartPort.timeScale.setVisibleLogicalRange.mockClear();
    chartPort.timeScale.scrollToPosition.mockClear();

    adapter.setCandles(recoveredHistory, { reset: false, historyReady: true });

    expect(adapter.getBarSpacing()).toBe(18);
    expect(chartPort.timeScale.setVisibleLogicalRange).not.toHaveBeenCalledWith({ from: 80, to: 120.5 });
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(1.5, false);
  });

  it("anchors recovered history at the live edge when no pre-clear user range exists", () => {
    const adapter = mounted();
    const firstHistory = Array.from({ length: 120 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_000 + index));
    const seed = candle(120_000, 2, 10_700);
    const recoveredHistory = firstHistory.map((item, index) => index === firstHistory.length - 1 ? seed : item);
    const seedRange = { from: -1, to: 0 };
    let rangePhase: "before-clear" | "seed" = "before-clear";
    chartPort.timeScale.getVisibleLogicalRange.mockImplementation(() =>
      rangePhase === "before-clear" ? null : seedRange,
    );
    adapter.setCandles(firstHistory, resetReady);
    adapter.setCandles([], { reset: true, historyReady: false });
    rangePhase = "seed";
    adapter.setCandles([seed], { reset: true, historyReady: false });
    chartPort.timeScale.fitContent.mockClear();
    chartPort.timeScale.setVisibleLogicalRange.mockClear();

    adapter.setCandles(recoveredHistory, { reset: false, historyReady: true });

    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(3, false);
    expect(chartPort.timeScale.setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it("anchors the first live candle after ready history is empty", () => {
    const adapter = mounted();
    const firstLive = candle(60_000, 1, 10_500);

    adapter.setCandles([], { reset: true, historyReady: true });
    chartPort.timeScale.fitContent.mockClear();

    adapter.setCandles([firstLive]);

    expect(chartPort.series.setData).toHaveBeenCalledWith([
      expect.objectContaining({ time: 60 }),
    ]);
    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    expect(chartPort.timeScale.scrollToPosition).toHaveBeenLastCalledWith(3, false);
  });

  it("preserves the user viewport after complete history is initialized", () => {
    const adapter = mounted();
    const history = Array.from({ length: 120 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_000 + index));
    const resync = history.map((item, index) => index === 0 || index === history.length - 1
      ? candle(item.timeMs, item.rev + 1, item.closeTicks + 25 + index)
      : item);
    const userRange = { from: 80, to: 119 };
    adapter.setCandles(history, resetReady);
    chartPort.timeScale.getVisibleLogicalRange.mockReturnValue(userRange);
    chartPort.timeScale.fitContent.mockClear();
    chartPort.timeScale.setVisibleLogicalRange.mockClear();

    adapter.setCandles(resync);

    expect(chartPort.timeScale.fitContent).not.toHaveBeenCalled();
    expect(chartPort.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith(userRange);
  });

  it("accepts empty candle arrays without chart updates", () => {
    const adapter = mounted();

    adapter.setCandles([]);

    expect(chartPort.series.setData).not.toHaveBeenCalled();
    expect(chartPort.series.update).not.toHaveBeenCalled();
  });

  it("clears rendered bars and inspection when current history becomes empty", () => {
    const onInspect = vi.fn();
    const adapter = mounted(onInspect);
    adapter.setCandles([candle(1_000, 1, 10_000)], resetReady);
    adapter.inspect(1_000);
    chartPort.series.setData.mockClear();
    chartPort.chart.clearCrosshairPosition.mockClear();
    onInspect.mockClear();

    adapter.setCandles([]);

    expect(chartPort.series.setData).toHaveBeenCalledWith([]);
    expect(chartPort.chart.clearCrosshairPosition).toHaveBeenCalled();
    expect(onInspect).toHaveBeenCalledWith(null);
  });

  it("clears rendered bars when an explicit reset has empty history", () => {
    const adapter = mounted();
    adapter.setCandles([candle(1_000, 1, 10_000)], resetReady);
    chartPort.series.setData.mockClear();

    adapter.setCandles([], resetReady);

    expect(chartPort.series.setData).toHaveBeenCalledWith([]);
  });

  it("maps pointer inspection to the full domain candle", () => {
    const onInspect = vi.fn();
    const adapter = mounted(onInspect);
    const inspected = candle(1_000, 1, 10_000, { volumeLots: 42 });
    adapter.setCandles([inspected], resetReady);

    crosshair(1, { time: 1, open: 99.5, high: 100.75, low: 98.75, close: 100 });

    expect(onInspect).toHaveBeenCalledWith(inspected);
  });

  it("clears pointer inspection when point is missing", () => {
    const onInspect = vi.fn();
    mounted(onInspect);

    chartPort.activeCrosshairHandler?.({ time: 1, seriesData: new Map() });

    expect(onInspect).toHaveBeenCalledWith(null);
  });

  it("clears pointer inspection when time is missing", () => {
    const onInspect = vi.fn();
    mounted(onInspect);

    chartPort.activeCrosshairHandler?.({ point: { x: 4, y: 8 }, seriesData: new Map() });

    expect(onInspect).toHaveBeenCalledWith(null);
  });

  it("clears pointer inspection when the series has no bar", () => {
    const onInspect = vi.fn();
    mounted(onInspect);

    crosshair(1, undefined);

    expect(onInspect).toHaveBeenCalledWith(null);
  });

  it("sets keyboard inspection to a domain candle and chart crosshair", () => {
    const onInspect = vi.fn();
    const adapter = mounted(onInspect);
    const inspected = candle(2_000, 1, 10_150);
    adapter.setCandles([candle(1_000), inspected], resetReady);

    adapter.inspect(2_000);

    expect(onInspect).toHaveBeenCalledWith(inspected);
    expect(chartPort.chart.setCrosshairPosition).toHaveBeenCalledWith(101.5, 2, chartPort.series);
  });

  it("clears keyboard inspection and chart crosshair for null time", () => {
    const onInspect = vi.fn();
    const adapter = mounted(onInspect);

    adapter.inspect(null);

    expect(onInspect).toHaveBeenCalledWith(null);
    expect(chartPort.chart.clearCrosshairPosition).toHaveBeenCalled();
  });

  it("disposes chart resources once and ignores later callbacks", () => {
    const onInspect = vi.fn();
    const adapter = mounted(onInspect);

    adapter.dispose();
    adapter.dispose();
    chartPort.lastCrosshairHandler?.({
      point: { x: 4, y: 8 },
      time: 1,
      seriesData: new Map([[chartPort.series, { time: 1 }]]),
    });

    expect(chartPort.chart.unsubscribeCrosshairMove).toHaveBeenCalledTimes(1);
    expect(chartPort.chart.remove).toHaveBeenCalledTimes(1);
    expect(onInspect).not.toHaveBeenCalled();
  });

  it("unsubscribes range changes once and ignores retained range callbacks after dispose", () => {
    const onFollowingChange = vi.fn();
    const adapter = mounted(vi.fn(), onFollowingChange);
    expect(chartPort.activeRangeHandler).toBeTypeOf("function");
    const retainedRangeHandler = chartPort.activeRangeHandler;

    adapter.dispose();
    adapter.dispose();
    retainedRangeHandler?.({ from: 0, to: 1 });

    expect(chartPort.timeScale.unsubscribeVisibleLogicalRangeChange).toHaveBeenCalledTimes(1);
    expect(chartPort.activeRangeHandler).toBeUndefined();
    expect(onFollowingChange).not.toHaveBeenCalled();
  });
});
