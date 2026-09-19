import { createStore, type StoreApi } from "zustand/vanilla";
import type { MarketRuntimeSnapshot } from "../domain/market-view";

export type MarketStore = StoreApi<MarketRuntimeSnapshot>;

export function createMarketStore(initial: MarketRuntimeSnapshot): MarketStore {
  return createStore<MarketRuntimeSnapshot>(() => initial);
}
