// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import { createInitialSnapshot } from "../runtime/create-market-runtime";
import { OrderBook } from "./order-book";

function snapshot(overrides: Partial<MarketRuntimeSnapshot> = {}): MarketRuntimeSnapshot {
  const base = createInitialSnapshot("1m");
  return {
    ...base,
    session: "session-1",
    symbol: "BTC-USD",
    meta: {
      ...base.meta,
      status: "ready",
      value: {
        session: "session-1",
        symbol: "BTC-USD",
        tickSize: "0.01",
        lotSize: "0.0001",
        intervals: ["1s", "1m", "5m"],
        referencePriceTicks: 10_000,
        tierPolicy: {
          initialTier: "full",
          flushMs: { full: 50, degraded: 250, minimal: 1000 },
          enterDegraded: { latencyAboveMs: 200, jitterAboveMs: 80 },
          enterMinimal: { latencyAboveMs: 800, jitterAboveMs: 250 },
          recoverFull: { latencyBelowMs: 120, jitterBelowMs: 40 },
          recoverDegraded: { latencyBelowMs: 400, jitterBelowMs: 120 },
          downgradeDwellMs: 1000,
          upgradeDwellMs: 3000,
          missingReportStepMs: 1000,
          missingReportMinimalMs: 4000,
          pingEveryMs: 1000,
          pongTimeoutMs: 800,
          reportEveryMs: 1000,
          rttWindowSamples: 8,
          minimumReportSamples: 3,
          hiddenCloseMs: 10_000,
        },
        retention: {
          historyCandles: { "1s": 120, "1m": 120, "5m": 120 },
          deliveryClosedCandles: 120,
          recentTrades: 80,
          bookChanges: 200,
          maximumBookLevelsPerSide: 20,
        },
      },
      ...overrides.meta,
    },
    book: {
      ...base.book,
      status: "synced",
      expectedSeq: 42,
      bids: [{ priceTicks: 9_990, quantityLots: 25_000 }],
      asks: [{ priceTicks: 10_010, quantityLots: 20_000 }],
      ...overrides.book,
    },
    diagnostics: {
      ...base.diagnostics,
      ...overrides.diagnostics,
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("OrderBook", () => {
  it("does not claim the snapshot is fetching when bounded recovery has failed", () => {
    render(<OrderBook snapshot={snapshot({
      book: {
        ...createInitialSnapshot("1m").book,
        status: "failed",
        attemptsUsed: 3,
        expectedSeq: 42,
      },
    })} />);

    expect(screen.queryByText(/Fetching snapshot/i)).toBeNull();
    expect(screen.getByText(/failed/i)).toBeTruthy();
  });

  it("does not show historical gap recovery text after the book is synced", () => {
    render(<OrderBook snapshot={snapshot({
      book: {
        ...createInitialSnapshot("1m").book,
        status: "synced",
        expectedSeq: 42,
        bids: [{ priceTicks: 9_990, quantityLots: 25_000 }],
        asks: [{ priceTicks: 10_010, quantityLots: 20_000 }],
      },
      diagnostics: {
        ...createInitialSnapshot("1m").diagnostics,
        lastError: "gap detected on previous session",
      },
    })} />);

    expect(screen.getByText("synced")).toBeTruthy();
    expect(screen.queryByText(/Fetching snapshot/i)).toBeNull();
    expect(screen.queryByText(/Book resyncing/i)).toBeNull();
  });


  it("renders asks worst-to-best above the spread without changing domain order", () => {
    const asks = Array.from({ length: 10 }, (_, index) => ({
      priceTicks: 10_010 + index,
      quantityLots: 20_000 + index,
    }));
    const bids = [
      { priceTicks: 9_990, quantityLots: 25_000 },
      { priceTicks: 9_980, quantityLots: 24_000 },
    ];
    const originalAskOrder = asks.map((level) => level.priceTicks);
    const originalBidOrder = bids.map((level) => level.priceTicks);
    const { container } = render(<OrderBook snapshot={snapshot({
      book: {
        ...createInitialSnapshot("1m").book,
        status: "synced",
        expectedSeq: 42,
        bids,
        asks,
      },
    })} />);

    const askRows = Array.from(container.querySelectorAll(".book-row.ask"));
    const bidRows = Array.from(container.querySelectorAll(".book-row.bid"));

    expect(askRows[0]?.textContent).toContain("100.19");
    expect(askRows[askRows.length - 1]?.textContent).toContain("100.10");
    expect(bidRows[0]?.textContent).toContain("99.90");
    expect(screen.getByText("0.20")).toBeTruthy();
    expect(asks.map((level) => level.priceTicks)).toEqual(originalAskOrder);
    expect(bids.map((level) => level.priceTicks)).toEqual(originalBidOrder);
  });

  it("shows resyncing when the current snapshot is buffering", () => {
    render(<OrderBook snapshot={snapshot({
      book: {
        ...createInitialSnapshot("1m").book,
        status: "buffering",
        bufferedRanges: 1,
        bufferedBytes: 320,
      },
    })} />);

    expect(screen.getAllByText("Book resyncing").length).toBeGreaterThan(0);
  });
});
