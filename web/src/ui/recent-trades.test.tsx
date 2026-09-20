// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialSnapshot } from "../runtime/create-market-runtime";
import { RecentTrades } from "./recent-trades";

const originalTZ = process.env.TZ;

function restoreTZ() {
  if (originalTZ === undefined) {
    delete process.env.TZ;
    return;
  }
  process.env.TZ = originalTZ;
}

afterEach(() => {
  cleanup();
  restoreTZ();
});

describe("RecentTrades", () => {
  it("labels and renders trade time in the viewer local zone", () => {
    process.env.TZ = "America/New_York";
    const base = createInitialSnapshot("1m");

    render(<RecentTrades snapshot={{
      ...base,
      meta: {
        ...base.meta,
        status: "ready",
        value: null,
      },
      trades: {
        ...base.trades,
        status: "ready",
        value: {
          session: "session-1",
          symbol: "BTC-USD",
          trades: [{
            id: 12,
            timeMs: Date.parse("2024-03-10T07:30:00Z"),
            priceTicks: 10_050,
            quantityLots: 4,
            side: "buy",
          }],
        },
        latestPriceTicks: 10_050,
        latestTradeId: 12,
      },
    }} />);

    const table = screen.getByRole("table", { name: "Recent trades table" });

    expect(within(table).getByRole("columnheader", { name: /time \(local\)/i })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "03:30:00" })).toBeTruthy();
  });
});
