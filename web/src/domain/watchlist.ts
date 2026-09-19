export type WatchlistSymbol = "BTC-USD" | "ETH-USD" | "SOL-USD" | "LINK-USD" | "AVAX-USD";

export const defaultWatchlistOrder = Object.freeze([
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "LINK-USD",
  "AVAX-USD",
] as const satisfies readonly WatchlistSymbol[]);

export function readWatchlistOrder(serialized: string | null): readonly WatchlistSymbol[] {
  if (serialized !== null && serialized.length <= 1024) {
    try {
      const order: unknown = JSON.parse(serialized);
      if (Array.isArray(order) && order.length === defaultWatchlistOrder.length
        && new Set(order).size === order.length
        && order.every((symbol: unknown) => defaultWatchlistOrder.some((supported) => supported === symbol))) {
        return order as WatchlistSymbol[];
      }
    } catch {
      // Invalid saved preferences use the default order.
    }
  }
  return [...defaultWatchlistOrder];
}

export function moveWatchlistItem(
  order: readonly WatchlistSymbol[],
  symbol: WatchlistSymbol,
  targetIndex: number,
): readonly WatchlistSymbol[] {
  const next = [...order];
  const fromIndex = next.indexOf(symbol);
  if (fromIndex < 0 || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= next.length) return next;
  next.splice(fromIndex, 1);
  next.splice(targetIndex, 0, symbol);
  return next;
}
