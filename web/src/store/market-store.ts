import type { StoreApi } from "zustand/vanilla";
import type { MarketRuntimeSnapshot } from "../domain/market-view";

export function createMarketStore(initial: MarketRuntimeSnapshot): StoreApi<MarketRuntimeSnapshot> {
  void initial;
  throw new Error("createMarketStore is not implemented");
}
