import { describe, expect, it } from "vitest";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import { createMarketStore } from "./market-store";

function sampleSnapshot(overrides: Partial<MarketRuntimeSnapshot> = {}): MarketRuntimeSnapshot {
  return {
    connection: {
      status: "live",
      hidden: false,
      online: true,
      reconnectAttempts: 0,
      terminalReason: null,
    },
    epoch: 1,
    session: "session-1",
    symbol: "BTC-USD",
    selectedInterval: "1s",
    reloadRequired: false,
    manualRetryRequired: false,
    cachedStale: false,
    liveEligible: true,
    meta: {
      status: "ready",
      value: null,
      error: null,
      attemptsUsed: 0,
    },
    book: {
      status: "synced",
      expectedSeq: 10,
      attemptsUsed: 0,
      bufferedRanges: 0,
      bufferedBytes: 0,
      bids: [{ priceTicks: 100, quantityLots: 2 }],
      asks: [{ priceTicks: 101, quantityLots: 1 }],
    },
    candles: {
      status: "ready",
      historyStatus: "ready",
      interval: "1s",
      requestId: 3,
      candles: [
        {
          timeMs: 1_000,
          openTicks: 100,
          highTicks: 102,
          lowTicks: 99,
          closeTicks: 101,
          volumeLots: 8,
          rev: 1,
          closed: false,
        },
      ],
      attemptsUsed: 0,
      error: null,
    },
    trades: {
      status: "ready",
      value: { session: "session-1", symbol: "BTC-USD", trades: [] },
      error: null,
      attemptsUsed: 0,
      latestPriceTicks: 101,
      latestTradeId: 7,
      skippedDisplayRecords: 0,
    },
    telemetry: {
      unresolved: 0,
      timedOutIds: [],
      successes: [],
    },
    freshness: {
      condition: "live",
      lastTransportAtMs: 1_000,
      lastMarketRev: 1,
    },
    tier: {
      effective: "full",
      auto: "full",
      forced: null,
      hidden: false,
      flushMs: 50,
      reason: null,
    },
    observedRate: {
      valuePerSecond: 20,
      windowMs: 1_000,
      sampleCount: 20,
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
    ...overrides,
  };
}

describe("createMarketStore", () => {
  it("returns the exact initial runtime snapshot as state", () => {
    const initial = sampleSnapshot();

    const store = createMarketStore(initial);

    expect(store.getState()).toBe(initial);
  });

  it("keeps independent store instances isolated", () => {
    const firstInitial = sampleSnapshot({ epoch: 1, session: "first" });
    const secondInitial = sampleSnapshot({ epoch: 2, session: "second" });
    const firstNext = sampleSnapshot({ epoch: 3, session: "first-next" });

    const firstStore = createMarketStore(firstInitial);
    const secondStore = createMarketStore(secondInitial);
    firstStore.setState(firstNext, true);

    expect(firstStore.getState()).toBe(firstNext);
    expect(secondStore.getState()).toBe(secondInitial);
  });

  it("replaces the whole runtime view and stops notifying after unsubscribe", () => {
    const initial = sampleSnapshot({ epoch: 1 });
    const next = sampleSnapshot({ epoch: 2, reloadRequired: true });
    const ignored = sampleSnapshot({ epoch: 3, manualRetryRequired: true });
    const store = createMarketStore(initial);
    const seen: MarketRuntimeSnapshot[] = [];

    const unsubscribe = store.subscribe((snapshot) => {
      seen.push(snapshot);
    });
    store.setState(next, true);
    unsubscribe();
    store.setState(ignored, true);

    expect(store.getState()).toBe(ignored);
    expect(seen).toEqual([next]);
  });
});
