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
      this.activeCrosshairHandler = undefined;
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

function mounted(onInspect = vi.fn()) {
  return mountCandleChart(container, { onInspect });
}

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

  it("converts domain milliseconds and ticks only at the chart edge", () => {
    const adapter = mounted();
    const first = candle(1_700_000_000_000, 3, 10_125, {
      openTicks: 10_000,
      highTicks: 10_250,
      lowTicks: 9_975,
    });

    adapter.setCandles([first], true);

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

    adapter.setCandles([candle(1_000), candle(2_000), candle(3_000)], true);

    expect(chartPort.series.setData.mock.calls[0][0].map((bar: { time: number }) => bar.time)).toEqual([1, 2, 3]);
  });

  it("uses explicit reset to replace sorted history", () => {
    const adapter = mounted();
    adapter.setCandles([candle(1_000)], true);
    chartPort.series.setData.mockClear();

    adapter.setCandles([candle(4_000), candle(5_000)], true);

    expect(chartPort.series.setData).toHaveBeenCalledWith([
      expect.objectContaining({ time: 4 }),
      expect.objectContaining({ time: 5 }),
    ]);
  });

  it("does not duplicate chart updates for unchanged candle data", () => {
    const adapter = mounted();
    const current = candle(1_000, 1, 10_000);
    adapter.setCandles([current], true);
    chartPort.series.setData.mockClear();
    chartPort.series.update.mockClear();

    adapter.setCandles([current]);

    expect(chartPort.series.setData).not.toHaveBeenCalled();
    expect(chartPort.series.update).not.toHaveBeenCalled();
  });

  it("updates the current candle incrementally", () => {
    const adapter = mounted();
    adapter.setCandles([candle(1_000, 1, 10_000)], true);
    chartPort.series.update.mockClear();

    adapter.setCandles([candle(1_000, 2, 10_050)]);

    expect(chartPort.series.update).toHaveBeenCalledWith(
      expect.objectContaining({ time: 1, close: 100.5 }),
    );
  });

  it("updates a new later candle incrementally", () => {
    const adapter = mounted();
    adapter.setCandles([candle(1_000, 1, 10_000)], true);
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
    adapter.setCandles([candle(1_000, 1, 10_000), candle(2_000, 1, 10_100)], true);
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

  it("replaces trimmed history while preserving the visible range", () => {
    const adapter = mounted();
    const visibleRange = { from: 900, to: 1_000 };
    const initial = Array.from({ length: 1_000 }, (_value, index) => candle(index * 1_000, 1, 10_000 + index));
    const trimmed = Array.from({ length: 1_000 }, (_value, index) => candle((index + 1) * 1_000, 1, 10_001 + index));
    adapter.setCandles(initial, true);
    chartPort.timeScale.getVisibleLogicalRange.mockReturnValue(visibleRange);
    chartPort.series.setData.mockClear();

    adapter.setCandles(trimmed);

    expect(chartPort.series.setData).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ time: 1_000 })]),
    );
    expect(chartPort.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith(visibleRange);
  });

  it("fits content only for the initial reset", () => {
    const adapter = mounted();

    adapter.setCandles([candle(1_000)], true);
    adapter.setCandles([candle(1_000), candle(2_000)], true);

    expect(chartPort.timeScale.fitContent).toHaveBeenCalledTimes(1);
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
    adapter.setCandles([candle(1_000, 1, 10_000)], true);
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
    adapter.setCandles([candle(1_000, 1, 10_000)], true);
    chartPort.series.setData.mockClear();

    adapter.setCandles([], true);

    expect(chartPort.series.setData).toHaveBeenCalledWith([]);
  });

  it("maps pointer inspection to the full domain candle", () => {
    const onInspect = vi.fn();
    const adapter = mounted(onInspect);
    const inspected = candle(1_000, 1, 10_000, { volumeLots: 42 });
    adapter.setCandles([inspected], true);

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
    adapter.setCandles([candle(1_000), inspected], true);

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
});
