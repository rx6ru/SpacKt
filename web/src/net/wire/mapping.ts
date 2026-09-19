import type {
  BookResetEvent,
  BookSnapshotDomain,
  CandlesResetEvent,
  HeartbeatEvent,
  HelloEvent,
  HistoryDomain,
  HttpErrorEnvelope,
  Meta,
  PongEvent,
  RecentTradesDomain,
  ServerErrorEvent,
  ServerEvent,
  SubscribedEvent,
  TierEvent,
  UpdateEvent,
} from "../../domain/events";
import type { Candle, Level, Trade } from "../../domain/model";
import {
  parsePrice,
  parseQuantity,
  type ErrorCode,
  type Interval,
  type Tier,
  type WireRecord,
} from "./support";

export type {
  BookResetEvent,
  BookSnapshotDomain,
  CandlesResetEvent,
  DebugCommand,
  DurationByTier,
  EntryThresholds,
  HeartbeatEvent,
  HelloEvent,
  HistoryDomain,
  HttpErrorEnvelope,
  Meta,
  PongEvent,
  RecentTradesDomain,
  RecoveryThresholds,
  RetentionPolicy,
  ServerErrorEvent,
  ServerEvent,
  SubscribedEvent,
  Symbol,
  Tier,
  TierEvent,
  TierPolicy,
  UpdateEvent,
} from "../../domain/events";

export function mapMeta(_value: WireRecord): Meta {
  return {
    session: stringField(_value, "session"),
    symbol: symbolField(_value),
    tickSize: stringField(_value, "tickSize"),
    lotSize: stringField(_value, "lotSize"),
    intervals: arrayField(_value, "intervals").map((interval) => intervalField({ interval }, "interval")),
    referencePriceTicks: parsePrice(_value.referencePrice).scaled,
    tierPolicy: mapTierPolicy(recordField(_value, "tierPolicy")),
    retention: mapRetention(recordField(_value, "retention")),
  };
}

export function mapBookSnapshot(_value: WireRecord): BookSnapshotDomain {
  return {
    session: stringField(_value, "session"),
    symbol: symbolField(_value),
    seq: numberField(_value, "seq"),
    timeMs: numberField(_value, "t"),
    bids: mapLevels(arrayField(_value, "bids")),
    asks: mapLevels(arrayField(_value, "asks")),
  };
}

export function mapHistory(_value: WireRecord): HistoryDomain {
  return {
    session: stringField(_value, "session"),
    symbol: symbolField(_value),
    interval: intervalField(_value, "interval"),
    requestId: numberField(_value, "requestId"),
    candles: arrayField(_value, "candles").map(mapCandle),
  };
}

export function mapRecentTrades(_value: WireRecord): RecentTradesDomain {
  return {
    session: stringField(_value, "session"),
    symbol: symbolField(_value),
    trades: arrayField(_value, "trades").map(mapTrade),
  };
}

export function mapServerEvent(_value: WireRecord, _wireBytes: number): ServerEvent {
  switch (stringField(_value, "type")) {
    case "hello":
      return mapHello(_value);
    case "subscribed":
      return mapSubscribed(_value);
    case "pong":
      return mapPong(_value);
    case "update":
      return mapUpdate(_value, _wireBytes);
    case "tier":
      return mapTier(_value);
    case "heartbeat":
      return mapHeartbeat(_value);
    case "book_reset":
      return mapBookReset(_value);
    case "candles_reset":
      return mapCandlesReset(_value);
    case "error":
      return mapServerError(_value);
    default:
      throw new Error("unknown server event type");
  }
}

export function mapHttpError(_value: WireRecord): HttpErrorEnvelope {
  const error = recordField(_value, "error");
  return {
    error: {
      code: errorCodeField(error, "code"),
      message: stringField(error, "message"),
    },
  };
}

function mapTierPolicy(value: WireRecord): Meta["tierPolicy"] {
  return {
    initialTier: tierField(value, "initialTier"),
    flushMs: mapDurationByTier(recordField(value, "flushMs")),
    enterDegraded: {
      latencyAboveMs: numberField(recordField(value, "enterDegraded"), "latencyAboveMs"),
      jitterAboveMs: numberField(recordField(value, "enterDegraded"), "jitterAboveMs"),
    },
    enterMinimal: {
      latencyAboveMs: numberField(recordField(value, "enterMinimal"), "latencyAboveMs"),
      jitterAboveMs: numberField(recordField(value, "enterMinimal"), "jitterAboveMs"),
    },
    recoverFull: {
      latencyBelowMs: numberField(recordField(value, "recoverFull"), "latencyBelowMs"),
      jitterBelowMs: numberField(recordField(value, "recoverFull"), "jitterBelowMs"),
    },
    recoverDegraded: {
      latencyBelowMs: numberField(recordField(value, "recoverDegraded"), "latencyBelowMs"),
      jitterBelowMs: numberField(recordField(value, "recoverDegraded"), "jitterBelowMs"),
    },
    downgradeDwellMs: numberField(value, "downgradeDwellMs"),
    upgradeDwellMs: numberField(value, "upgradeDwellMs"),
    missingReportStepMs: numberField(value, "missingReportStepMs"),
    missingReportMinimalMs: numberField(value, "missingReportMinimalMs"),
    pingEveryMs: numberField(value, "pingEveryMs"),
    pongTimeoutMs: numberField(value, "pongTimeoutMs"),
    reportEveryMs: numberField(value, "reportEveryMs"),
    rttWindowSamples: numberField(value, "rttWindowSamples"),
    minimumReportSamples: numberField(value, "minimumReportSamples"),
    hiddenCloseMs: numberField(value, "hiddenCloseMs"),
  };
}

function mapDurationByTier(value: WireRecord): Meta["tierPolicy"]["flushMs"] {
  return {
    full: numberField(value, "full"),
    degraded: numberField(value, "degraded"),
    minimal: numberField(value, "minimal"),
  };
}

function mapRetention(value: WireRecord): Meta["retention"] {
  const historyCandles = recordField(value, "historyCandles");
  return {
    historyCandles: {
      "1s": numberField(historyCandles, "1s"),
      "1m": numberField(historyCandles, "1m"),
      "5m": numberField(historyCandles, "5m"),
    },
    deliveryClosedCandles: numberField(value, "deliveryClosedCandles"),
    recentTrades: numberField(value, "recentTrades"),
    bookChanges: numberField(value, "bookChanges"),
    maximumBookLevelsPerSide: numberField(value, "maximumBookLevelsPerSide"),
  };
}

function mapHello(value: WireRecord): HelloEvent {
  return {
    type: "hello",
    session: stringField(value, "session"),
    symbol: symbolField(value),
    protocolVersion: numberField(value, "v"),
    connId: stringField(value, "connId"),
    tier: tierField(value, "tier"),
    autoTier: tierField(value, "autoTier"),
    forced: nullableTierField(value, "forced"),
    hidden: booleanField(value, "hidden"),
    flushMs: numberField(value, "flushMs"),
  };
}

function mapSubscribed(value: WireRecord): SubscribedEvent {
  return {
    type: "subscribed",
    session: stringField(value, "session"),
    interval: intervalField(value, "interval"),
    requestId: numberField(value, "requestId"),
  };
}

function mapPong(value: WireRecord): PongEvent {
  return {
    type: "pong",
    session: stringField(value, "session"),
    id: numberField(value, "id"),
  };
}

function mapTier(value: WireRecord): TierEvent {
  return {
    type: "tier",
    session: stringField(value, "session"),
    tier: tierField(value, "tier"),
    autoTier: tierField(value, "autoTier"),
    forced: nullableTierField(value, "forced"),
    hidden: booleanField(value, "hidden"),
    flushMs: numberField(value, "flushMs"),
    reason: stringField(value, "reason"),
  };
}

function mapHeartbeat(value: WireRecord): HeartbeatEvent {
  return {
    type: "heartbeat",
    session: stringField(value, "session"),
    marketRev: numberField(value, "marketRev"),
    bookSeq: numberField(value, "bookSeq"),
    candleRequestId: nullableNumberField(value, "candleRequestId"),
    candleLatestRev: nullableNumberField(value, "candleLatestRev"),
    feedReady: booleanField(value, "feedReady"),
  };
}

function mapBookReset(value: WireRecord): BookResetEvent {
  return {
    type: "book_reset",
    session: stringField(value, "session"),
    reason: cursorExpiredReason(value),
  };
}

function mapCandlesReset(value: WireRecord): CandlesResetEvent {
  return {
    type: "candles_reset",
    session: stringField(value, "session"),
    interval: intervalField(value, "interval"),
    requestId: numberField(value, "requestId"),
    reason: cursorExpiredReason(value),
  };
}

function mapServerError(value: WireRecord): ServerErrorEvent {
  return {
    type: "error",
    session: stringField(value, "session"),
    code: errorCodeField(value, "code"),
    message: stringField(value, "message"),
  };
}

function mapUpdate(value: WireRecord, wireBytes: number): UpdateEvent {
  const event: UpdateEvent = {
    type: "update",
    session: stringField(value, "session"),
    marketRev: numberField(value, "marketRev"),
    wireBytes,
  };

  if ("book" in value) {
    event.book = mapBookRange(recordField(value, "book"));
  }
  if ("candles" in value) {
    event.candles = mapCandleBatch(recordField(value, "candles"));
  }
  if ("trades" in value) {
    event.trades = arrayField(value, "trades").map(mapTrade);
  }
  if ("skipped" in value) {
    event.skipped = numberField(value, "skipped");
  }

  return event;
}

function mapBookRange(value: WireRecord): NonNullable<UpdateEvent["book"]> {
  return {
    from: numberField(value, "from"),
    to: numberField(value, "to"),
    bids: mapLevels(arrayField(value, "bids")),
    asks: mapLevels(arrayField(value, "asks")),
  };
}

function mapCandleBatch(value: WireRecord): NonNullable<UpdateEvent["candles"]> {
  return {
    requestId: numberField(value, "requestId"),
    interval: intervalField(value, "interval"),
    items: arrayField(value, "items").map(mapCandle),
  };
}

function mapLevels(value: unknown[]): Level[] {
  return value.map((level) => {
    if (!Array.isArray(level) || level.length !== 2) {
      throw new Error("invalid mapped level");
    }
    return {
      priceTicks: parsePrice(level[0]).scaled,
      quantityLots: parseQuantity(level[1], false).scaled,
    };
  });
}

function mapCandle(value: unknown): Candle {
  const candle = recordValue(value);
  return {
    timeMs: numberField(candle, "t"),
    openTicks: parsePrice(candle.o).scaled,
    highTicks: parsePrice(candle.h).scaled,
    lowTicks: parsePrice(candle.l).scaled,
    closeTicks: parsePrice(candle.c).scaled,
    volumeLots: parseQuantity(candle.v, false).scaled,
    rev: numberField(candle, "rev"),
    closed: booleanField(candle, "closed"),
  };
}

function mapTrade(value: unknown): Trade {
  const trade = recordValue(value);
  return {
    id: numberField(trade, "id"),
    timeMs: numberField(trade, "t"),
    priceTicks: parsePrice(trade.p).scaled,
    quantityLots: parseQuantity(trade.q, true).scaled,
    side: stringField(trade, "side"),
  };
}

function cursorExpiredReason(value: WireRecord): "cursor_expired" {
  const reason = stringField(value, "reason");
  if (reason !== "cursor_expired") {
    throw new Error("invalid reset reason");
  }
  return reason;
}

function recordField(value: WireRecord, key: string): WireRecord {
  return recordValue(value[key]);
}

function recordValue(value: unknown): WireRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected mapped object");
  }
  return value as WireRecord;
}

function arrayField(value: WireRecord, key: string): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    throw new Error(`expected mapped array: ${key}`);
  }
  return field;
}

function stringField(value: WireRecord, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`expected mapped string: ${key}`);
  }
  return field;
}

function symbolField(value: WireRecord): "BTC-USD" {
  const symbol = stringField(value, "symbol");
  if (symbol !== "BTC-USD") {
    throw new Error("invalid mapped symbol");
  }
  return symbol;
}

function numberField(value: WireRecord, key: string): number {
  const field = value[key];
  if (typeof field !== "number") {
    throw new Error(`expected mapped number: ${key}`);
  }
  return field;
}

function nullableNumberField(value: WireRecord, key: string): number | null {
  return value[key] === null ? null : numberField(value, key);
}

function booleanField(value: WireRecord, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`expected mapped boolean: ${key}`);
  }
  return field;
}

function intervalField(value: WireRecord, key: string): Interval {
  const interval = stringField(value, key);
  if (interval !== "1s" && interval !== "1m" && interval !== "5m") {
    throw new Error("invalid mapped interval");
  }
  return interval;
}

function tierField(value: WireRecord, key: string): Tier {
  const tier = stringField(value, key);
  if (tier !== "full" && tier !== "degraded" && tier !== "minimal") {
    throw new Error("invalid mapped tier");
  }
  return tier;
}

function nullableTierField(value: WireRecord, key: string): Tier | null {
  return value[key] === null ? null : tierField(value, key);
}

function errorCodeField(value: WireRecord, key: string): ErrorCode {
  return stringField(value, key) as ErrorCode;
}
