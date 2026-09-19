import type { DebugCommand } from "../domain/events";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import type { Interval } from "../domain/model";
import type { MarketRuntime, MarketRuntimeOptions } from "./types";

export type {
  BrowserCloseCode,
  BrowserEvents,
  MarketRuntime,
  MarketRuntimeOptions,
  RuntimeSocket,
  Scheduler,
  WebSocketDriver,
} from "./types";
export type {
  BookView,
  CandleView,
  ConnectionView,
  DiagnosticsView,
  FreshnessView,
  MarketRuntimeSnapshot,
  ObservedRateView,
  ResourceStatus,
  ResourceView,
  TelemetryView,
  TierView,
  TradesView,
} from "../domain/market-view";

export function createMarketRuntime(options: MarketRuntimeOptions): MarketRuntime {
  const initialSnapshot = createInitialSnapshot(options.defaultInterval);

  return {
    start(): void {
      throw new Error("Not implemented: MarketRuntime.start");
    },
    dispose(): void {
      throw new Error("Not implemented: MarketRuntime.dispose");
    },
    selectInterval(interval: Interval): void {
      void interval;
      throw new Error("Not implemented: MarketRuntime.selectInterval");
    },
    retry(): void {
      throw new Error("Not implemented: MarketRuntime.retry");
    },
    debug(command: DebugCommand): void {
      void command;
      throw new Error("Not implemented: MarketRuntime.debug");
    },
    getSnapshot(): MarketRuntimeSnapshot {
      return cloneSnapshot(initialSnapshot);
    },
    subscribe(listener: () => void): () => void {
      void listener;
      throw new Error("Not implemented: MarketRuntime.subscribe");
    },
  };
}

function createInitialSnapshot(selectedInterval: Interval): MarketRuntimeSnapshot {
  return {
    connection: {
      status: "idle",
      hidden: false,
      online: true,
      reconnectAttempts: 0,
      terminalReason: null,
    },
    epoch: 0,
    session: null,
    symbol: null,
    selectedInterval,
    reloadRequired: false,
    manualRetryRequired: false,
    cachedStale: false,
    liveEligible: false,
    meta: {
      status: "idle",
      value: null,
      error: null,
      attemptsUsed: 0,
    },
    book: {
      status: "idle",
      expectedSeq: null,
      attemptsUsed: 0,
      bufferedRanges: 0,
      bufferedBytes: 0,
      bids: [],
      asks: [],
    },
    candles: {
      status: "idle",
      interval: null,
      requestId: null,
      candles: [],
      attemptsUsed: 0,
      error: null,
    },
    trades: {
      status: "idle",
      value: null,
      error: null,
      attemptsUsed: 0,
      latestPriceTicks: null,
      latestTradeId: null,
      skippedDisplayRecords: 0,
    },
    telemetry: {
      unresolved: 0,
      timedOutIds: [],
      successes: [],
    },
    freshness: {
      condition: "waiting",
      lastTransportAtMs: null,
      lastMarketRev: null,
    },
    tier: {
      effective: null,
      auto: null,
      forced: null,
      hidden: false,
      flushMs: null,
      reason: null,
    },
    observedRate: {
      valuePerSecond: null,
      windowMs: 10_000,
      sampleCount: 0,
    },
    diagnostics: {
      lastError: null,
      malformedMessages: 0,
      staleCallbacksIgnored: 0,
      requestErrors: {
        meta: null,
        book: null,
        trades: null,
        history: null,
      },
    },
  };
}

function cloneSnapshot(snapshot: MarketRuntimeSnapshot): MarketRuntimeSnapshot {
  return {
    ...snapshot,
    connection: { ...snapshot.connection },
    meta: { ...snapshot.meta },
    book: {
      ...snapshot.book,
      bids: snapshot.book.bids.map((level) => ({ ...level })),
      asks: snapshot.book.asks.map((level) => ({ ...level })),
    },
    candles: {
      ...snapshot.candles,
      candles: snapshot.candles.candles.map((candle) => ({ ...candle })),
    },
    trades: { ...snapshot.trades },
    telemetry: {
      unresolved: snapshot.telemetry.unresolved,
      timedOutIds: [...snapshot.telemetry.timedOutIds],
      successes: snapshot.telemetry.successes.map((sample) => ({ ...sample })),
    },
    freshness: { ...snapshot.freshness },
    tier: { ...snapshot.tier },
    observedRate: { ...snapshot.observedRate },
    diagnostics: {
      ...snapshot.diagnostics,
      requestErrors: { ...snapshot.diagnostics.requestErrors },
    },
  };
}
