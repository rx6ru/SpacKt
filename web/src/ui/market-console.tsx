"use client";

import { useSyncExternalStore } from "react";
import type { DebugCommand } from "../domain/market-view";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import type { Interval } from "../domain/model";
import type { MarketStore } from "../store/market-store";
import { PriceHeader } from "./price-header";
import { ConnectionStatus } from "./status";
import { MarketChart } from "./market-chart";
import { OrderBook } from "./order-book";
import { RecentTrades } from "./recent-trades";
import { DiagnosticsDrawer } from "./diagnostics";
import { Watchlist } from "./watchlist";

type MarketConsoleProps = {
  store: MarketStore;
  onSelectInterval: (interval: Interval) => void;
  onRetry: () => void;
  onDebug: (command: DebugCommand) => void;
};

export function MarketConsole({ store, onSelectInterval, onRetry, onDebug }: MarketConsoleProps) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getInitialState,
  );

  const stateClass = screenState(snapshot).toLowerCase().replaceAll(" ", "-");

  return (
    <main className={`console-shell state-${stateClass}`} aria-label="SpacKt market console">
      <PriceHeader snapshot={snapshot} />
      <ConnectionStatus snapshot={snapshot} onRetry={onRetry} />
      <div className="console-layout">
        <div className="market-flow">
          <MarketChart snapshot={snapshot} onSelectInterval={onSelectInterval} />
          <RecentTrades snapshot={snapshot} />
        </div>
        <div className="aside-flow">
          <OrderBook snapshot={snapshot} />
        </div>
        <div className="watch-flow">
          <Watchlist />
          <DiagnosticsDrawer snapshot={snapshot} onDebug={onDebug} onRetry={onRetry} />
        </div>
      </div>
    </main>
  );
}

function screenState(snapshot: MarketRuntimeSnapshot): string {
  if (snapshot.reloadRequired) return "Reload required";
  if (snapshot.manualRetryRequired) return "Recovery failed";
  if (!snapshot.connection.online) return "Offline";
  if (snapshot.connection.status === "reconnecting") return "Reconnecting";
  if (snapshot.connection.status === "connecting") return "Connecting";
  if (snapshot.freshness.condition === "feed-delayed") return "Feed delayed";
  if (snapshot.cachedStale || snapshot.freshness.condition === "stale") return "Stale";
  if (snapshot.liveEligible) return "Live";
  return "Syncing";
}
