export type HeartbeatEvidence = {
  epoch: number;
  marketRev: number;
  flushMs: number;
  advertisedHeads?: {
    bookSeq?: number;
    candle?: { requestId: number; revision: number };
  };
};

export type PanelAppliedEvidence = {
  epoch: number;
  panel: "book" | "candles";
  head: number;
  requestId?: number;
};

export type FreshnessEffects = {
  reconnect?: { epoch: number; reason: "transport_silence" };
  markFeedDelayed?: { epoch: number; delayed: boolean };
  resyncPanel?: {
    epoch: number;
    panel: "book" | "candles";
    reason: "advertised_head_stalled";
  };
  clearEvidence?: { epoch: number };
};

export type FreshnessState = {
  epoch: number;
  hidden: boolean;
  condition: "waiting" | "live" | "stale" | "feed-delayed";
  lastTransportAtMs: number | null;
  lastMarketRev: number | null;
  selectedCandleRequestId: number | null;
};

export class FreshnessMonitor {
  constructor(_options: { now: () => number }) {}

  reset(epoch: number): FreshnessEffects { throw new Error("Not implemented"); }
  visibilityChanged(hidden: boolean): FreshnessEffects { throw new Error("Not implemented"); }
  transportReceived(epoch: number): FreshnessEffects { throw new Error("Not implemented"); }
  heartbeat(message: HeartbeatEvidence): FreshnessEffects { throw new Error("Not implemented"); }
  panelApplied(message: PanelAppliedEvidence): FreshnessEffects { throw new Error("Not implemented"); }
  selectedCandleRequest(requestId: number): FreshnessEffects { throw new Error("Not implemented"); }
  advance(): FreshnessEffects { throw new Error("Not implemented"); }
  getState(): FreshnessState { throw new Error("Not implemented"); }
}
