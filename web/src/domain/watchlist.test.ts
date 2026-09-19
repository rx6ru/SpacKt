import { describe, expect, it } from "vitest";
import {
  defaultWatchlistOrder,
  moveWatchlistItem,
  readWatchlistOrder,
  type WatchlistSymbol,
} from "./watchlist";

const defaultOrder = [...defaultWatchlistOrder];

const mutableDefault = (): WatchlistSymbol[] => [...defaultWatchlistOrder];

describe("watchlist stored order", () => {
  it("exports the assignment watchlist order as a frozen value", () => {
    expect(defaultWatchlistOrder).toEqual(["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD", "AVAX-USD"]);
    expect(Object.isFrozen(defaultWatchlistOrder)).toBe(true);
  });

  it("returns the default order when no stored value exists", () => {
    expect(readWatchlistOrder(null)).toEqual(defaultOrder);
  });

  it("returns a new default array when no stored value exists", () => {
    expect(readWatchlistOrder(null)).not.toBe(defaultWatchlistOrder);
  });

  it("accepts a valid permutation with each supported symbol once", () => {
    expect(readWatchlistOrder(JSON.stringify(["SOL-USD", "BTC-USD", "AVAX-USD", "ETH-USD", "LINK-USD"]))).toEqual([
      "SOL-USD",
      "BTC-USD",
      "AVAX-USD",
      "ETH-USD",
      "LINK-USD",
    ]);
  });

  it.each([
    ["malformed JSON", "[BTC-USD]"],
    ["non-array JSON", JSON.stringify({ order: defaultOrder })],
    ["duplicate symbol", JSON.stringify(["BTC-USD", "BTC-USD", "SOL-USD", "LINK-USD", "AVAX-USD"])],
    ["missing symbol", JSON.stringify(["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD"])],
    ["extra symbol", JSON.stringify(["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD", "AVAX-USD", "DOGE-USD"])],
    ["unsupported symbol", JSON.stringify(["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD", "DOGE-USD"])],
    ["non-string item", JSON.stringify(["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD", 42])],
  ])("returns the default order for %s", (_name, serialized) => {
    expect(readWatchlistOrder(serialized)).toEqual(defaultOrder);
  });

  it("returns the default order for oversized stored text", () => {
    expect(readWatchlistOrder("[" + " ".repeat(1024) + "]")).toEqual(defaultOrder);
  });

  it("does not let mutation of one returned default order affect another read", () => {
    const first = readWatchlistOrder(null) as WatchlistSymbol[];
    first.reverse();

    expect(readWatchlistOrder(null)).toEqual(defaultOrder);
  });
});

describe("watchlist movement", () => {
  it("moves an earlier symbol to the requested final index", () => {
    expect(moveWatchlistItem(defaultWatchlistOrder, "BTC-USD", 3)).toEqual([
      "ETH-USD",
      "SOL-USD",
      "LINK-USD",
      "BTC-USD",
      "AVAX-USD",
    ]);
  });

  it("moves a later symbol to the requested final index", () => {
    expect(moveWatchlistItem(defaultWatchlistOrder, "LINK-USD", 1)).toEqual([
      "BTC-USD",
      "LINK-USD",
      "ETH-USD",
      "SOL-USD",
      "AVAX-USD",
    ]);
  });

  it("moves the last symbol to the first boundary index", () => {
    expect(moveWatchlistItem(defaultWatchlistOrder, "AVAX-USD", 0)).toEqual([
      "AVAX-USD",
      "BTC-USD",
      "ETH-USD",
      "SOL-USD",
      "LINK-USD",
    ]);
  });

  it("moves the first symbol to the last boundary index", () => {
    expect(moveWatchlistItem(defaultWatchlistOrder, "BTC-USD", 4)).toEqual([
      "ETH-USD",
      "SOL-USD",
      "LINK-USD",
      "AVAX-USD",
      "BTC-USD",
    ]);
  });

  it.each([-1, 5, 1.5, Number.NaN])("returns a copied order for invalid target index %s", (targetIndex) => {
    const order = mutableDefault();
    const moved = moveWatchlistItem(order, "SOL-USD", targetIndex);

    expect(moved).toEqual(defaultOrder);
    expect(moved).not.toBe(order);
  });

  it("returns a copied order for a same-index move", () => {
    const order = mutableDefault();
    const moved = moveWatchlistItem(order, "SOL-USD", 2);

    expect(moved).toEqual(defaultOrder);
    expect(moved).not.toBe(order);
  });

  it("does not mutate the caller-owned order", () => {
    const order = mutableDefault();

    moveWatchlistItem(order, "ETH-USD", 4);

    expect(order).toEqual(defaultOrder);
  });
});
