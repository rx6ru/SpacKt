import type {
  DebugCommand,
  Meta,
  RecentTradesDomain,
  Symbol,
  Tier,
} from "./events";
import type { Candle, Interval, Level } from "./model";

export type { DebugCommand, Meta, RecentTradesDomain, Symbol, Tier };

export type MarketRuntimeSnapshot = {
  connection: ConnectionView;
  epoch: number;
  session: string | null;
  symbol: Symbol | null;
  selectedInterval: Interval;
  reloadRequired: boolean;
  manualRetryRequired: boolean;
  cachedStale: boolean;
  liveEligible: boolean;
  meta: ResourceView<Meta>;
  book: BookView;
  candles: CandleView;
  trades: TradesView;
  telemetry: TelemetryView;
  freshness: FreshnessView;
  tier: TierView;
  observedRate: ObservedRateView;
  diagnostics: DiagnosticsView;
};

export type ResourceStatus = "idle" | "loading" | "ready" | "failed";

export type ResourceView<T> = {
  status: ResourceStatus;
  value: T | null;
  error: string | null;
  attemptsUsed: number;
};

export type ConnectionView = {
  status: "idle" | "connecting" | "live" | "reconnecting" | "offline" | "terminal";
  hidden: boolean;
  online: boolean;
  reconnectAttempts: number;
  terminalReason: "protocol_mismatch" | "reload_required" | null;
};

export type BookView = {
  status: "idle" | "buffering" | "synced" | "failed";
  expectedSeq: number | null;
  attemptsUsed: number;
  bufferedRanges: number;
  bufferedBytes: number;
  bids: Level[];
  asks: Level[];
};

export type CandleView = {
  status: "idle" | "loading" | "ready" | "invalid";
  interval: Interval | null;
  requestId: number | null;
  candles: Candle[];
  attemptsUsed: number;
  error: string | null;
};

export type TradesView = ResourceView<RecentTradesDomain> & {
  latestPriceTicks: number | null;
  latestTradeId: number | null;
  skippedDisplayRecords: number;
};

export type TelemetryView = {
  unresolved: number;
  timedOutIds: number[];
  successes: Array<{
    id: number;
    sentAtMs: number;
    receivedAtMs: number;
    rttMs: number;
  }>;
};

export type FreshnessView = {
  condition: "waiting" | "live" | "stale" | "feed-delayed";
  lastTransportAtMs: number | null;
  lastMarketRev: number | null;
};

export type TierView = {
  effective: Tier | null;
  auto: Tier | null;
  forced: Tier | null;
  hidden: boolean;
  flushMs: number | null;
  reason: string | null;
};

export type ObservedRateView = {
  valuePerSecond: number | null;
  windowMs: number;
  sampleCount: number;
};

export type DiagnosticsView = {
  lastError: string | null;
  malformedMessages: number;
  staleCallbacksIgnored: number;
  requestErrors: Record<"meta" | "book" | "trades" | "history", string | null>;
};
