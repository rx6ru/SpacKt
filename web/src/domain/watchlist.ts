export type WatchlistSymbol = "BTC-USD" | "ETH-USD" | "SOL-USD" | "LINK-USD" | "AVAX-USD";

export const defaultWatchlistOrder = Object.freeze([
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "LINK-USD",
  "AVAX-USD",
] as const satisfies readonly WatchlistSymbol[]);

export function readWatchlistOrder(_serialized: string | null): readonly WatchlistSymbol[] {
  throw new Error("watchlist domain is not implemented");
}

export function moveWatchlistItem(
  _order: readonly WatchlistSymbol[],
  _symbol: WatchlistSymbol,
  _targetIndex: number,
): readonly WatchlistSymbol[] {
  throw new Error("watchlist domain is not implemented");
}
