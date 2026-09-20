"use client";

import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { ChevronLeftIcon, ChevronRightIcon, ReloadIcon } from "@radix-ui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import type { Candle, Interval } from "../domain/model";
import { formatCandle, formatLocalTime, formatLots, formatPriceTicks, latestCandle } from "./format";

type MarketChartProps = {
  snapshot: MarketRuntimeSnapshot;
  onSelectInterval: (interval: Interval) => void;
};

export function MarketChart({ snapshot, onSelectInterval }: MarketChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<Awaited<ReturnType<typeof loadAdapter>> | null>(null);
  const latestCandlesRef = useRef(candlesPayload(snapshot));
  const generationRef = useRef(0);
  const lastBarSpacingRef = useRef<number | undefined>(undefined);
  const [retryVersion, setRetryVersion] = useState(0);
  const [chartError, setChartError] = useState(false);
  const [followingLive, setFollowingLive] = useState(true);
  const [inspectedKey, setInspectedKey] = useState<{
    session: string | null;
    interval: Interval;
    timeMs: number;
  } | null>(null);
  const candles = snapshot.candles.candles;
  const meta = snapshot.meta.value;

  const inspectedCandle = useMemo(() => {
    if (
      !inspectedKey ||
      inspectedKey.session !== snapshot.session ||
      inspectedKey.interval !== snapshot.selectedInterval
    ) {
      return null;
    }
    return candles.find((candle) => candle.timeMs === inspectedKey.timeMs) ?? null;
  }, [candles, inspectedKey, snapshot.selectedInterval, snapshot.session]);

  const activeCandle = inspectedCandle ?? latestCandle(candles);

  useEffect(() => {
    let disposed = false;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const container = containerRef.current;
    if (!container) return undefined;

    setChartError(false);
    setFollowingLive(true);
    void loadAdapter(container, {
      initialBarSpacing: lastBarSpacingRef.current,
      onInspect: (candle) => {
        if (generationRef.current !== generation) return;
        setInspectedKey(candle ? {
          session: snapshot.session,
          interval: snapshot.selectedInterval,
          timeMs: candle.timeMs,
        } : null);
      },
      onFollowingChange: (following) => {
        if (generationRef.current !== generation) return;
        setFollowingLive(following);
      },
    }).then((adapter) => {
      if (disposed || generationRef.current !== generation) {
        adapter.dispose();
        return;
      }
      adapterRef.current = adapter;
      applyCandles(adapter, latestCandlesRef.current, setChartError);
    }).catch(() => {
      if (!disposed && generationRef.current === generation) {
        adapterRef.current = null;
        setChartError(true);
      }
    });

    return () => {
      disposed = true;
      generationRef.current += 1;
      const adapter = adapterRef.current;
      adapterRef.current = null;
      if (adapter) {
        lastBarSpacingRef.current = adapter.getBarSpacing();
      }
      adapter?.inspect(null);
      adapter?.dispose();
    };
  }, [retryVersion, snapshot.selectedInterval, snapshot.session]);

  useEffect(() => {
    latestCandlesRef.current = candlesPayload(snapshot);
    const adapter = adapterRef.current;
    if (!adapter) return;
    applyCandles(adapter, candlesPayload(snapshot), setChartError);
  }, [snapshot]);

  const inspectedIndex = useMemo(() => {
    if (!inspectedCandle) return Math.max(0, candles.length - 1);
    const index = candles.findIndex((candle) => candle.timeMs === inspectedCandle.timeMs);
    return index >= 0 ? index : Math.max(0, candles.length - 1);
  }, [candles, inspectedCandle]);

  function moveInspection(direction: -1 | 1) {
    if (candles.length === 0) return;
    const nextIndex = Math.min(candles.length - 1, Math.max(0, inspectedIndex + direction));
    const next = candles[nextIndex] ?? null;
    if (next) {
      setInspectedKey({ session: snapshot.session, interval: snapshot.selectedInterval, timeMs: next.timeMs });
    }
    adapterRef.current?.inspect(next?.timeMs ?? null);
  }

  function followLive() {
    adapterRef.current?.followLive();
  }

  const chartState = chartError ? "Chart unavailable" : chartStateText(snapshot);

  return (
    <section className="panel chart-panel" aria-label="Candlestick chart">
      <div className="panel-heading chart-heading">
        <div>
          <h2>Candlestick chart</h2>
        </div>
        <ToggleGroup.Root
          aria-label="Chart interval"
          className="segmented"
          type="single"
          value={snapshot.selectedInterval}
          onValueChange={(value) => {
            if (value) onSelectInterval(value as Interval);
          }}
        >
          {(["1s", "1m", "5m"] as const).map((interval) => (
            <ToggleGroup.Item key={interval} className="segment" value={interval} aria-label={interval}>
              {interval}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
      </div>
      <div
        className="chart-frame"
        tabIndex={0}
        aria-label={`Candlestick chart summary. ${formatCandle(activeCandle, meta)}`}
      >
        <div ref={containerRef} className="chart-canvas" />
        {!followingLive && !chartError ? (
          <div className="chart-live-control">
            <button type="button" className="compact-action" onClick={followLive}>
              Go Live
            </button>
          </div>
        ) : null}
        {chartState ? (
          <div className={chartError ? "chart-state chart-error" : "chart-state"}>
            <span>{chartState}</span>
            {chartError ? (
              <button type="button" className="compact-action" onClick={() => setRetryVersion((value) => value + 1)}>
                <ReloadIcon aria-hidden="true" />
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="chart-inspector">
        <button type="button" className="icon-action" aria-label="Previous candle" disabled={candles.length === 0} onClick={() => moveInspection(-1)}>
          <ChevronLeftIcon aria-hidden="true" />
        </button>
        <div className="candle-legend">
          <span className="legend-mode">{inspectedCandle ? "Inspecting candle" : "Latest candle"}</span>
          <LegendCell label="Local time" value={formatLocalTime(activeCandle?.timeMs)} />
          <LegendCell label="O" value={formatPriceTicks(activeCandle?.openTicks, meta)} />
          <LegendCell label="H" value={formatPriceTicks(activeCandle?.highTicks, meta)} />
          <LegendCell label="L" value={formatPriceTicks(activeCandle?.lowTicks, meta)} />
          <LegendCell label="C" value={formatPriceTicks(activeCandle?.closeTicks, meta)} />
          <LegendCell label="V" value={formatLots(activeCandle?.volumeLots, meta)} />
        </div>
        <button type="button" className="icon-action" aria-label="Next candle" disabled={candles.length === 0} onClick={() => moveInspection(1)}>
          <ChevronRightIcon aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function LegendCell({ label, value }: { label: string; value: string }) {
  return (
    <span className="legend-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

async function loadAdapter(
  container: HTMLDivElement,
  options: {
    onInspect: (candle: Candle | null) => void;
    onFollowingChange: (following: boolean) => void;
    initialBarSpacing?: number;
  },
) {
  const { mountCandleChart } = await import("../chart/adapter");
  return mountCandleChart(container, options);
}

function applyCandles(
  adapter: Awaited<ReturnType<typeof loadAdapter>>,
  payload: { candles: readonly Candle[]; loading: boolean; historyReady: boolean },
  setChartError: (value: boolean) => void,
) {
  try {
    adapter.setCandles(payload.candles, { reset: payload.loading, historyReady: payload.historyReady });
    setChartError(false);
  } catch {
    setChartError(true);
  }
}

function candlesPayload(snapshot: MarketRuntimeSnapshot) {
  return {
    candles: snapshot.candles.candles,
    loading: snapshot.candles.historyStatus === "loading",
    historyReady: snapshot.candles.historyStatus === "ready",
  };
}

function chartStateText(snapshot: MarketRuntimeSnapshot): string | null {
  if (snapshot.candles.historyStatus === "loading") return `Loading ${snapshot.selectedInterval} history`;
  if (snapshot.candles.historyStatus === "ready" && snapshot.candles.candles.length === 0) {
    return "No history yet. Live candles will appear here.";
  }
  if (snapshot.cachedStale || snapshot.freshness.condition === "stale") {
    return "Cached values";
  }
  return null;
}
