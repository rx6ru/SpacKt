import { describe, expect, it } from "vitest";
import { RecentTrades } from "./recent-trades";

const trade = (id: number, priceTicks: number) => ({
  id,
  timeMs: 1700000000000 + id,
  priceTicks,
  quantityLots: 10,
  side: "buy" as const,
});

describe("RecentTrades", () => {
  it("keeps newer live trades when a late REST response has older IDs", () => {
    const trades = new RecentTrades();

    trades.merge("s1", [trade(102, 10200)]);
    trades.merge("s1", [trade(100, 10000), trade(99, 9900)]);

    expect(trades.getState()).toMatchObject({
      session: "s1",
      latestTradeId: 102,
      latestPriceTicks: 10200,
    });
    expect(trades.getState().trades.map((item) => item.id)).toEqual([102, 100, 99]);
  });

  it("ignores a stale-session REST response even when it has larger trade IDs", () => {
    const trades = new RecentTrades();

    trades.merge("s1", [trade(102, 10200)]);
    trades.merge("old-session", [trade(200, 20000)]);

    expect(trades.getState()).toMatchObject({
      session: "s1",
      latestTradeId: 102,
      latestPriceTicks: 10200,
    });
    expect(trades.getState().trades.map((item) => item.id)).toEqual([102]);
  });

  it("deduplicates repeated trade IDs within the active session", () => {
    const trades = new RecentTrades();

    trades.merge("s1", [trade(100, 10000), trade(101, 10100)]);
    trades.merge("s1", [trade(101, 99999), trade(102, 10200)]);

    expect(trades.getState().trades).toEqual([trade(102, 10200), trade(101, 10100), trade(100, 10000)]);
  });

  it("retains at most one hundred newest trades", () => {
    const trades = new RecentTrades();

    trades.merge(
      "s1",
      Array.from({ length: 101 }, (_, index) => trade(index + 1, 10000 + index)),
    );

    const state = trades.getState();
    expect(state.trades).toHaveLength(100);
    expect(state.trades[0]!.id).toBe(101);
    expect(state.trades[99]!.id).toBe(2);
  });

  it("resets the active session when reset is called", () => {
    const trades = new RecentTrades();

    trades.merge("s1", [trade(102, 10200)]);
    trades.reset("s2");

    expect(trades.getState()).toEqual({
      session: "s2",
      trades: [],
      latestPriceTicks: null,
      latestTradeId: null,
    });
  });
});
