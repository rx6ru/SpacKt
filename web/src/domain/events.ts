import type { Candle, Interval, Level, Trade } from "./model";

export type Symbol = "BTC-USD";

export type Tier = "full" | "degraded" | "minimal";

export type DebugCommand =
  | { action: "forceTier"; value: Tier | "auto" }
  | { action: "dropNextBookDelta" }
  | { action: "disconnect" }
  | { action: "pongDelay"; value: number };

export type DurationByTier = {
  full: number;
  degraded: number;
  minimal: number;
};

export type EntryThresholds = {
  latencyAboveMs: number;
  jitterAboveMs: number;
};

export type RecoveryThresholds = {
  latencyBelowMs: number;
  jitterBelowMs: number;
};

export type TierPolicy = {
  initialTier: Tier;
  flushMs: DurationByTier;
  enterDegraded: EntryThresholds;
  enterMinimal: EntryThresholds;
  recoverFull: RecoveryThresholds;
  recoverDegraded: RecoveryThresholds;
  downgradeDwellMs: number;
  upgradeDwellMs: number;
  missingReportStepMs: number;
  missingReportMinimalMs: number;
  pingEveryMs: number;
  pongTimeoutMs: number;
  reportEveryMs: number;
  rttWindowSamples: number;
  minimumReportSamples: number;
  hiddenCloseMs: number;
};

export type RetentionPolicy = {
  historyCandles: Record<Interval, number>;
  deliveryClosedCandles: number;
  recentTrades: number;
  bookChanges: number;
  maximumBookLevelsPerSide: number;
};

export type Meta = {
  session: string;
  symbol: Symbol;
  tickSize: string;
  lotSize: string;
  intervals: Interval[];
  referencePriceTicks: number;
  tierPolicy: TierPolicy;
  retention: RetentionPolicy;
};

export type BookSnapshotDomain = {
  session: string;
  symbol: Symbol;
  seq: number;
  timeMs: number;
  bids: Level[];
  asks: Level[];
};

export type HistoryDomain = {
  session: string;
  symbol: Symbol;
  interval: Interval;
  requestId: number;
  candles: Candle[];
};

export type RecentTradesDomain = {
  session: string;
  symbol: Symbol;
  trades: Trade[];
};

export type HelloEvent = {
  type: "hello";
  session: string;
  symbol: Symbol;
  protocolVersion: number;
  connId: string;
  tier: Tier;
  autoTier: Tier;
  forced: Tier | null;
  hidden: boolean;
  flushMs: number;
};

export type SubscribedEvent = {
  type: "subscribed";
  session: string;
  interval: Interval;
  requestId: number;
};

export type PongEvent = {
  type: "pong";
  session: string;
  id: number;
};

export type TierEvent = {
  type: "tier";
  session: string;
  tier: Tier;
  autoTier: Tier;
  forced: Tier | null;
  hidden: boolean;
  flushMs: number;
  reason: string;
};

export type UpdateEvent = {
  type: "update";
  session: string;
  marketRev: number;
  book?: { from: number; to: number; bids: Level[]; asks: Level[] };
  candles?: { requestId: number; interval: Interval; items: Candle[] };
  trades?: Trade[];
  skipped?: number;
  wireBytes: number;
};

export type HeartbeatEvent = {
  type: "heartbeat";
  session: string;
  marketRev: number;
  bookSeq: number;
  candleRequestId: number | null;
  candleLatestRev: number | null;
  feedReady: boolean;
};

export type BookResetEvent = {
  type: "book_reset";
  session: string;
  reason: "cursor_expired";
};

export type CandlesResetEvent = {
  type: "candles_reset";
  session: string;
  interval: Interval;
  requestId: number;
  reason: "cursor_expired";
};

export type ServerErrorEvent = {
  type: "error";
  session: string;
  code: string;
  message: string;
};

export type ServerEvent =
  | HelloEvent
  | SubscribedEvent
  | PongEvent
  | UpdateEvent
  | TierEvent
  | HeartbeatEvent
  | BookResetEvent
  | CandlesResetEvent
  | ServerErrorEvent;

export type HttpErrorEnvelope = {
  error: {
    code: string;
    message: string;
  };
};
