// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import { createInitialSnapshot } from "../runtime/create-market-runtime";
import { PriceHeader } from "./price-header";

const originalTZ = process.env.TZ;
const indiaOffset = /GMT\+0?5:?30/;

function restoreTZ() {
  if (originalTZ === undefined) {
    delete process.env.TZ;
    return;
  }
  process.env.TZ = originalTZ;
}

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
    trades: {
      ...base.trades,
      status: "ready",
      value: {
        session: "session-1",
        symbol: "BTC-USD",
        trades: [{ id: 7, timeMs: 1_700_000_000_000, priceTicks: 10_050, quantityLots: 4, side: "buy" }],
      },
      latestPriceTicks: 10_050,
      latestTradeId: 7,
      ...overrides.trades,
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  restoreTZ();
});

describe("PriceHeader", () => {
  it("renders the latest price as actual DOM text in the labelled field", () => {
    render(<PriceHeader snapshot={snapshot()} />);

    const latestPrice = screen.getByLabelText(/^Latest price/);

    expect(latestPrice.textContent).toContain("$100.50");
  });

  it("renders the market movement as actual DOM text in the labelled field", () => {
    render(<PriceHeader snapshot={snapshot()} />);

    const movement = screen.getByLabelText(/^Up /);

    expect(movement.textContent).toContain("+$0.50");
    expect(movement.textContent).toContain("+0.50%");
  });

  it("shows unavailable price and neutral movement when latest price is missing", () => {
    render(<PriceHeader snapshot={snapshot({
      trades: {
        ...createInitialSnapshot("1m").trades,
        status: "ready",
        value: { session: "session-1", symbol: "BTC-USD", trades: [] },
        latestPriceTicks: null,
        latestTradeId: null,
      },
    })} />);

    const latestPrice = screen.getByLabelText("Latest price");
    const movement = screen.getByLabelText("Movement unavailable");

    expect(latestPrice.textContent).toBe("-");
    expect(movement.textContent).toContain("-");
    expect(movement.className).not.toContain("positive");
    expect(movement.className).not.toContain("negative");
  });

  it("shows actual latest price and neutral movement when reference price is missing", () => {
    render(<PriceHeader snapshot={snapshot({
      meta: {
        ...createInitialSnapshot("1m").meta,
        status: "ready",
        value: null,
      },
    })} />);

    const latestPrice = screen.getByLabelText("Latest price");
    const movement = screen.getByLabelText("Movement unavailable");

    expect(latestPrice.textContent).toContain("$100.50");
    expect(movement.textContent).toContain("-");
    expect(movement.className).not.toContain("positive");
    expect(movement.className).not.toContain("negative");
  });

  it("shows the latest trade time in the viewer local offset", () => {
    process.env.TZ = "Asia/Kolkata";

    render(<PriceHeader snapshot={snapshot({
      trades: {
        ...createInitialSnapshot("1m").trades,
        status: "ready",
        value: {
          session: "session-1",
          symbol: "BTC-USD",
          trades: [{
            id: 8,
            timeMs: Date.parse("2024-01-01T23:30:00Z"),
            priceTicks: 10_050,
            quantityLots: 4,
            side: "buy",
          }],
        },
        latestPriceTicks: 10_050,
        latestTradeId: 8,
      },
    })} />);

    expect(screen.getByText(/Last trade/).textContent).toMatch(new RegExp(`^Last trade 05:00:00 ${indiaOffset.source}$`));
  });
});
