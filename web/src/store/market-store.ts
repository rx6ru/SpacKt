import { createStore, type StoreApi } from "zustand/vanilla";
import type { MarketRuntimeSnapshot } from "../domain/market-view";

export function createMarketStore(initial: MarketRuntimeSnapshot): StoreApi<MarketRuntimeSnapshot> {
  return createStore<MarketRuntimeSnapshot>(() => initial);
}
