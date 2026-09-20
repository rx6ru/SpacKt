import type { Candle } from "../domain/model";
import {
  formatLocalDateTimeWithZone,
  formatLocalDay,
  formatLocalMinute,
  formatLocalMonth,
  formatLocalTime,
  formatLocalYear,
} from "./display-time";
import {
  CandlestickSeries,
  createChart,
  TickMarkType,
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
  followLive(): void;
  getBarSpacing(): number;
  dispose(): void;
};

type CandleChartMountOptions = {
  onInspect: (candle: Candle | null) => void;
  onFollowingChange?: (following: boolean) => void;
  initialBarSpacing?: number;
};

type RecoveryAnchor = {
  range: LogicalRange;
  timeMs: number;
  index: number;
};

const DEFAULT_BAR_SPACING = 12;
const LIVE_RIGHT_OFFSET = 3;

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
    tickMarkFormatter: formatChartTick,
    barSpacing: DEFAULT_BAR_SPACING,
    rightOffset: LIVE_RIGHT_OFFSET,
  },
  localization: {
    timeFormatter: formatChartTime,
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

function chartTimeToMs(time: Time): number | null {
  if (typeof time === "number") {
    return time * 1_000;
  }
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return Date.UTC(time.year, time.month - 1, time.day);
}

function formatChartTime(time: Time): string {
  return formatLocalDateTimeWithZone(chartTimeToMs(time));
}

function formatChartTick(time: Time, tickMarkType: TickMarkType): string {
  const timeMs = chartTimeToMs(time);
  switch (tickMarkType) {
    case TickMarkType.Year:
      return formatLocalYear(timeMs);
    case TickMarkType.Month:
      return formatLocalMonth(timeMs);
    case TickMarkType.DayOfMonth:
      return formatLocalDay(timeMs);
    case TickMarkType.Time:
      return formatLocalMinute(timeMs);
    case TickMarkType.TimeWithSeconds:
      return formatLocalTime(timeMs);
    default:
      return formatLocalTime(timeMs);
  }
}

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

function rangeWithSharedCandleAnchor(
  range: LogicalRange,
  previousCandles: readonly Candle[],
  candles: readonly Candle[],
): LogicalRange {
  if (previousCandles.length === 0 || candles.length === 0) {
    return range;
  }

  const previousIndex = Math.min(previousCandles.length - 1, Math.max(0, Math.floor(range.to)));
  const anchor = previousCandles[previousIndex];
  if (!anchor) {
    return range;
  }

  const nextIndex = candles.findIndex((candle) => candle.timeMs === anchor.timeMs);
  if (nextIndex < 0) {
    return range;
  }

  const delta = nextIndex - previousIndex;
  return {
    from: (range.from + delta) as LogicalRange["from"],
    to: (range.to + delta) as LogicalRange["to"],
  };
}

function recoveryAnchorForRange(range: LogicalRange, candles: readonly Candle[]): RecoveryAnchor | null {
  if (candles.length === 0) {
    return null;
  }
  const index = Math.min(candles.length - 1, Math.max(0, Math.floor(range.to)));
  const anchor = candles[index];
  return anchor ? { range: { ...range }, timeMs: anchor.timeMs, index } : null;
}

function rangeFromRecoveryAnchor(anchor: RecoveryAnchor, candles: readonly Candle[]): LogicalRange {
  const nextIndex = candles.findIndex((candle) => candle.timeMs === anchor.timeMs);
  if (nextIndex < 0) {
    return anchor.range;
  }
  const delta = nextIndex - anchor.index;
  return {
    from: (anchor.range.from + delta) as LogicalRange["from"],
    to: (anchor.range.to + delta) as LogicalRange["to"],
  };
}

export function mountCandleChart(
  container: HTMLElement,
  options: CandleChartMountOptions,
): CandleChartAdapter {
  const chartOptions = {
    ...CHART_OPTIONS,
    timeScale: {
      ...CHART_OPTIONS.timeScale,
      barSpacing: options.initialBarSpacing ?? DEFAULT_BAR_SPACING,
    },
  };
  const chart = createChart(container, chartOptions as Parameters<typeof createChart>[1]);
  const series = chart.addSeries(CandlestickSeries, CANDLE_OPTIONS) as CandleSeries;
  const timeScale = chart.timeScale();
  let disposed = false;
  let anchoredInitialContent = false;
  let waitingForHistory = false;
  let recoveryAnchor: RecoveryAnchor | null = null;
  let recoveryWasFollowing = true;
  let recoveryLiveOffset = LIVE_RIGHT_OFFSET;
  let following = true;
  let mutatingData = false;
  let lastVisibleRange: LogicalRange | null = null;
  let previousCandles: readonly Candle[] = [];
  let candleByTimeMs = new Map<number, Candle>();
  let candleByChartTime = new Map<number, Candle>();

  function replaceIndexes(candles: readonly Candle[]): void {
    candleByTimeMs = new Map(candles.map((candle) => [candle.timeMs, candle]));
    candleByChartTime = new Map(candles.map((candle) => [candle.timeMs / 1_000, candle]));
  }

  function setFollowing(nextFollowing: boolean): void {
    if (following === nextFollowing) {
      return;
    }
    following = nextFollowing;
    options.onFollowingChange?.(following);
  }

  function getPositiveScrollPosition(): number | null {
    const position = timeScale.scrollPosition();
    return typeof position === "number" && Number.isFinite(position) && position >= 0 ? position : null;
  }

  function scrollToLive(position = LIVE_RIGHT_OFFSET): void {
    timeScale.scrollToPosition(position, false);
  }

  function rangeShowsLatest(range: LogicalRange | null, candles: readonly Candle[]): boolean {
    if (!range || candles.length === 0) {
      return true;
    }
    const lastIndex = candles.length - 1;
    return range.from <= lastIndex && range.to >= lastIndex;
  }

  function isHistoricalView(range: LogicalRange | null, candles: readonly Candle[]): boolean {
    const position = timeScale.scrollPosition();
    return (typeof position === "number" && Number.isFinite(position) && position < 0)
      || !rangeShowsLatest(range, candles);
  }

  function runWithoutRangeCallbacks(action: () => void): void {
    mutatingData = true;
    try {
      action();
    } finally {
      mutatingData = false;
    }
  }

  function replaceData(candles: readonly Candle[]): void {
    const visibleRange = !waitingForHistory ? timeScale.getVisibleLogicalRange() : null;
    const liveOffset = getPositiveScrollPosition();
    const keepFollowing = following && liveOffset !== null && !isHistoricalView(visibleRange, previousCandles);
    if (following && !keepFollowing) {
      setFollowing(false);
    }
    series.setData(candles.map(toChartBar));
    if (keepFollowing) {
      scrollToLive(liveOffset ?? LIVE_RIGHT_OFFSET);
    } else if (visibleRange) {
      timeScale.setVisibleLogicalRange(rangeWithSharedCandleAnchor(visibleRange, previousCandles, candles));
    }
  }

  function applyHistoryViewport(candles: readonly Candle[], historyReady: boolean): void {
    if (!historyReady) return;
    if (waitingForHistory) {
      waitingForHistory = false;
      const savedAnchor = recoveryAnchor;
      recoveryAnchor = null;
      if (!recoveryWasFollowing && savedAnchor && candles.length > 0) {
        timeScale.setVisibleLogicalRange(rangeFromRecoveryAnchor(savedAnchor, candles));
        return;
      }
      if (candles.length > 0) {
        scrollToLive(recoveryWasFollowing ? recoveryLiveOffset : LIVE_RIGHT_OFFSET);
        anchoredInitialContent = true;
      }
      return;
    }
    if (!anchoredInitialContent && candles.length > 0) {
      scrollToLive();
      anchoredInitialContent = true;
    }
  }

  function clearData(): void {
    runWithoutRangeCallbacks(() => series.setData([]));
    previousCandles = [];
    replaceIndexes([]);
    options.onInspect(null);
    chart.clearCrosshairPosition();
  }

  const handleVisibleRangeChange = (range: LogicalRange | null): void => {
    if (disposed || mutatingData || waitingForHistory || !range || previousCandles.length === 0) {
      return;
    }
    lastVisibleRange = range;
    setFollowing(!isHistoricalView(range, previousCandles));
  };

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
  timeScale.subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

  return {
    setCandles(candles, { reset = false, historyReady = true } = {}): void {
      if (disposed) {
        return;
      }
      if (reset && !historyReady && !waitingForHistory) {
        waitingForHistory = true;
        const visibleRange = previousCandles.length > 0 ? timeScale.getVisibleLogicalRange() : null;
        recoveryWasFollowing = following && !isHistoricalView(visibleRange, previousCandles);
        recoveryLiveOffset = recoveryWasFollowing ? getPositiveScrollPosition() ?? LIVE_RIGHT_OFFSET : LIVE_RIGHT_OFFSET;
        recoveryAnchor = !recoveryWasFollowing && visibleRange
          ? recoveryAnchorForRange(visibleRange, previousCandles)
          : null;
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
        runWithoutRangeCallbacks(() => series.setData(candles.map(toChartBar)));
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
        const liveOffset = getPositiveScrollPosition();
        const visibleRange = lastVisibleRange ?? timeScale.getVisibleLogicalRange();
        const keepFollowing = following && liveOffset !== null && !isHistoricalView(visibleRange, previousCandles);
        if (following && !keepFollowing) {
          setFollowing(false);
        }
        series.update(toChartBar(nextLast));
        if (keepFollowing) {
          scrollToLive(liveOffset);
        }
      } else if (candles.length === previousCandles.length && nextLast.timeMs === previousLast.timeMs) {
        const changedIndexes = candles
          .map((candle, index) => sameCandle(candle, previousCandles[index]) ? -1 : index)
          .filter((index) => index >= 0);
        const [changedIndex] = changedIndexes;
        if (changedIndexes.length !== 1 || changedIndex === undefined) {
          runWithoutRangeCallbacks(() => replaceData(candles));
        } else if (changedIndex === candles.length - 1) {
          series.update(toChartBar(nextLast));
        } else {
          series.update(toChartBar(candles[changedIndex]), true);
        }
      } else {
        runWithoutRangeCallbacks(() => replaceData(candles));
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
    followLive(): void {
      if (disposed) {
        return;
      }
      scrollToLive();
      setFollowing(true);
    },
    getBarSpacing(): number {
      const spacing = timeScale.options().barSpacing;
      return typeof spacing === "number" && Number.isFinite(spacing) ? spacing : DEFAULT_BAR_SPACING;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      timeScale.unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      chart.remove();
    },
  };
}
