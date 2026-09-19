import type { Candle } from "../domain/model";
import {
  CandlestickSeries,
  createChart,
  type CandlestickData,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

export type CandleChartAdapter = {
  setCandles(candles: readonly Candle[], options?: { reset?: boolean; historyReady?: boolean }): void;
  inspect(timeMs: number | null): void;
  dispose(): void;
};

const CHART_OPTIONS = {
  autoSize: true,
  layout: {
    background: { type: "solid", color: "#0B0D10" },
    textColor: "#F4F0E7",
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
    attributionLogo: true,
  },
  grid: {
    vertLines: { color: "#2C3440" },
    horzLines: { color: "#2C3440" },
  },
  rightPriceScale: {
    borderColor: "#2C3440",
  },
  timeScale: {
    borderColor: "#2C3440",
    timeVisible: true,
    secondsVisible: true,
  },
};

const CANDLE_OPTIONS = {
  upColor: "#6FD6A7",
  downColor: "#FF7A7A",
  borderUpColor: "#6FD6A7",
  borderDownColor: "#FF7A7A",
  wickUpColor: "#6FD6A7",
  wickDownColor: "#FF7A7A",
  priceFormat: { type: "price", precision: 2, minMove: 0.01 },
} as const;

type ChartBar = CandlestickData<UTCTimestamp>;
type CandleSeries = ISeriesApi<"Candlestick", Time>;

function toChartTime(timeMs: number): UTCTimestamp {
  return (timeMs / 1_000) as UTCTimestamp;
}

function toChartPrice(ticks: number): number {
  return ticks / 100;
}

function toChartBar(candle: Candle): ChartBar {
  return {
    time: toChartTime(candle.timeMs),
    open: toChartPrice(candle.openTicks),
    high: toChartPrice(candle.highTicks),
    low: toChartPrice(candle.lowTicks),
    close: toChartPrice(candle.closeTicks),
  };
}

function sameCandle(left: Candle, right: Candle): boolean {
  return left.timeMs === right.timeMs
    && left.openTicks === right.openTicks
    && left.highTicks === right.highTicks
    && left.lowTicks === right.lowTicks
    && left.closeTicks === right.closeTicks
    && left.volumeLots === right.volumeLots
    && left.rev === right.rev
    && left.closed === right.closed;
}

function sameHistory(left: readonly Candle[], right: readonly Candle[]): boolean {
  return left.length === right.length && left.every((candle, index) => sameCandle(candle, right[index]));
}

function samePrefix(left: readonly Candle[], right: readonly Candle[], length: number): boolean {
  return left.length >= length && right.length >= length
    && Array.from({ length }).every((_value, index) => sameCandle(left[index], right[index]));
}

export function mountCandleChart(
  container: HTMLElement,
  options: { onInspect: (candle: Candle | null) => void },
): CandleChartAdapter {
  const chart = createChart(container, CHART_OPTIONS as Parameters<typeof createChart>[1]);
  const series = chart.addSeries(CandlestickSeries, CANDLE_OPTIONS) as CandleSeries;
  const timeScale = chart.timeScale();
  let disposed = false;
  let fittedInitialContent = false;
  let waitingForHistory = false;
  let recoveryViewport: LogicalRange | null = null;
  let previousCandles: readonly Candle[] = [];
  let candleByTimeMs = new Map<number, Candle>();
  let candleByChartTime = new Map<number, Candle>();

  function replaceIndexes(candles: readonly Candle[]): void {
    candleByTimeMs = new Map(candles.map((candle) => [candle.timeMs, candle]));
    candleByChartTime = new Map(candles.map((candle) => [candle.timeMs / 1_000, candle]));
  }

  function replaceData(candles: readonly Candle[]): void {
    const visibleRange = fittedInitialContent && !waitingForHistory ? timeScale.getVisibleLogicalRange() : null;
    series.setData(candles.map(toChartBar));
    if (visibleRange) {
      timeScale.setVisibleLogicalRange(visibleRange);
    }
  }

  function applyHistoryViewport(candles: readonly Candle[], historyReady: boolean): void {
    if (!historyReady) return;
    if (waitingForHistory) {
      waitingForHistory = false;
      const savedRange = recoveryViewport;
      recoveryViewport = null;
      if (savedRange && candles.length > 0) {
        timeScale.setVisibleLogicalRange(savedRange);
        return;
      }
      fittedInitialContent = false;
    }
    if (!fittedInitialContent && candles.length > 0) {
      timeScale.fitContent();
      fittedInitialContent = true;
    }
  }

  function clearData(): void {
    series.setData([]);
    previousCandles = [];
    replaceIndexes([]);
    options.onInspect(null);
    chart.clearCrosshairPosition();
  }

  const handleCrosshairMove = (param: MouseEventParams<Time>): void => {
    if (disposed) {
      return;
    }
    if (!param.point || param.time === undefined || param.seriesData.get(series) === undefined) {
      options.onInspect(null);
      return;
    }
    options.onInspect(candleByChartTime.get(Number(param.time)) ?? null);
  };

  chart.subscribeCrosshairMove(handleCrosshairMove);

  return {
    setCandles(candles, { reset = false, historyReady = true } = {}): void {
      if (disposed) {
        return;
      }
      if (reset && !historyReady && !waitingForHistory) {
        waitingForHistory = true;
        const visibleRange = fittedInitialContent ? timeScale.getVisibleLogicalRange() : null;
        recoveryViewport = visibleRange ? { ...visibleRange } : null;
      }
      if (sameHistory(previousCandles, candles)) {
        applyHistoryViewport(candles, historyReady);
        return;
      }

      if (candles.length === 0) {
        if (previousCandles.length > 0 || reset) {
          clearData();
        }
        applyHistoryViewport(candles, historyReady);
        return;
      }

      if (reset || previousCandles.length === 0) {
        replaceData(candles);
        previousCandles = candles;
        replaceIndexes(candles);
        applyHistoryViewport(candles, historyReady);
        return;
      }

      const previousLast = previousCandles.at(-1);
      const nextLast = candles.at(-1);
      if (!previousLast || !nextLast) {
        return;
      }

      if (candles.length === previousCandles.length + 1 && samePrefix(candles, previousCandles, previousCandles.length)) {
        series.update(toChartBar(nextLast));
      } else if (candles.length === previousCandles.length && nextLast.timeMs === previousLast.timeMs) {
        const changedIndexes = candles
          .map((candle, index) => sameCandle(candle, previousCandles[index]) ? -1 : index)
          .filter((index) => index >= 0);
        const [changedIndex] = changedIndexes;
        if (changedIndexes.length !== 1 || changedIndex === undefined) {
          replaceData(candles);
        } else if (changedIndex === candles.length - 1) {
          series.update(toChartBar(nextLast));
        } else {
          series.update(toChartBar(candles[changedIndex]), true);
        }
      } else {
        replaceData(candles);
      }

      previousCandles = candles;
      replaceIndexes(candles);
      applyHistoryViewport(candles, historyReady);
    },
    inspect(timeMs): void {
      if (disposed) {
        return;
      }
      if (timeMs === null) {
        options.onInspect(null);
        chart.clearCrosshairPosition();
        return;
      }
      const candle = candleByTimeMs.get(timeMs);
      options.onInspect(candle ?? null);
      if (candle) {
        chart.setCrosshairPosition(toChartPrice(candle.closeTicks), toChartTime(candle.timeMs), series);
      } else {
        chart.clearCrosshairPosition();
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
    },
  };
}
