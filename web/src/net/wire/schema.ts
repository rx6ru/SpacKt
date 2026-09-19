import type { Trade } from "../../domain/model";
import {
  assertByteLimit,
  assertJsonDepth,
  assertJsonSafe,
  expectArray,
  expectBoolean,
  expectBoundedSafeUint,
  expectDisplayText,
  expectDuration,
  expectErrorCode,
  expectExactNumber,
  expectExactString,
  expectFiniteNumber,
  expectInterval,
  expectNullablePositiveId,
  expectNullableTier,
  expectObject,
  expectObjectAllowOptional,
  expectObjectWithType,
  expectOneOf,
  expectPositiveId,
  expectSafeUint,
  expectSessionId,
  expectSessionSymbol,
  expectSymbol,
  expectTier,
  parseKind,
  parsePrice,
  parseQuantity,
  tradeSides,
  type Interval,
  type SchemaKind,
  type WireRecord,
} from "./support";
import { validateMeta } from "./meta";

export function decodeWire(kind: string, raw: string): WireRecord {
  const schemaKind = parseKind(kind);
  assertByteLimit(schemaKind, raw);
  assertJsonDepth(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error("invalid JSON", { cause });
  }

  return validateByKind(schemaKind, parsed);
}

export function encodeWire(kind: string, value: unknown): string {
  const schemaKind = parseKind(kind);
  assertJsonSafe(value);

  const normalized = validateByKind(schemaKind, value);
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined) {
    throw new Error("cannot encode value");
  }

  assertByteLimit(schemaKind, encoded);
  return encoded;
}

export function toTrade(value: WireRecord): Trade {
  const trade = validateTrade(value, true);

  return {
    id: trade.id,
    timeMs: trade.t,
    priceTicks: parsePrice(trade.p).scaled,
    quantityLots: parseQuantity(trade.q, true).scaled,
    side: trade.side,
  };
}

function validateByKind(kind: SchemaKind, value: unknown): WireRecord {
  switch (kind) {
    case "meta":
      return validateMeta(value);
    case "book":
      return validateBookSnapshot(value);
    case "history":
      return validateHistory(value);
    case "trades":
      return validateRecentTrades(value);
    case "httpError":
      return validateHttpError(value);
    case "health":
      return validateStatus(value, ["ok"]);
    case "readiness":
      return validateStatus(value, ["ok", "not_ready"]);
    case "client":
      return validateClientMessage(value);
    case "server":
      return validateServerMessage(value);
  }
}

function validateBookSnapshot(value: unknown): WireRecord {
  const object = expectSessionSymbol(value, ["seq", "t", "bids", "asks"]);
  const bids = validateLevels(object.bids, "bids", 10, 50, true);
  const asks = validateLevels(object.asks, "asks", 10, 50, true);
  assertNonCrossing(bids, asks);

  return {
    session: object.session,
    symbol: object.symbol,
    seq: expectSafeUint(object.seq, "seq"),
    t: expectSafeUint(object.t, "t"),
    bids,
    asks,
  };
}

function validateHistory(value: unknown): WireRecord {
  const object = expectSessionSymbol(value, ["interval", "requestId", "candles"]);
  const interval = expectInterval(object.interval, "interval");
  const candles = expectArray(object.candles, "candles").map((item) => validateCandle(item, interval));
  if (candles.length > 1000) {
    throw new Error("too many candles");
  }
  assertCandlesAscending(candles);

  return {
    session: object.session,
    symbol: object.symbol,
    interval,
    requestId: expectSafeUint(object.requestId, "requestId"),
    candles,
  };
}

function validateRecentTrades(value: unknown): WireRecord {
  const object = expectSessionSymbol(value, ["trades"]);
  const trades = expectArray(object.trades, "trades").map((item) => validateTrade(item, true));
  if (trades.length > 100) {
    throw new Error("too many trades");
  }
  for (let index = 1; index < trades.length; index += 1) {
    if (trades[index - 1].id <= trades[index].id) {
      throw new Error("trades must descend by id");
    }
  }

  return {
    session: object.session,
    symbol: object.symbol,
    trades,
  };
}

function validateHttpError(value: unknown): WireRecord {
  const object = expectObject(value, ["error"]);
  const error = expectObject(object.error, ["code", "message"]);

  return {
    error: {
      code: expectErrorCode(error.code, "error.code"),
      message: expectDisplayText(error.message, "error.message"),
    },
  };
}

function validateStatus(value: unknown, statuses: readonly string[]): WireRecord {
  const object = expectObject(value, ["status"]);
  if (typeof object.status !== "string" || !statuses.includes(object.status)) {
    throw new Error("invalid status");
  }
  return { status: object.status };
}

function validateClientMessage(value: unknown): WireRecord {
  const base = expectObjectWithType(value);
  switch (base.type) {
    case "subscribe": {
      const object = expectObject(value, ["type", "session", "interval", "requestId"]);
      return {
        type: "subscribe",
        session: expectSessionId(object.session, "session"),
        interval: expectInterval(object.interval, "interval"),
        requestId: expectPositiveId(object.requestId, "requestId"),
      };
    }
    case "ping": {
      const object = expectObject(value, ["type", "session", "id"]);
      return {
        type: "ping",
        session: expectSessionId(object.session, "session"),
        id: expectPositiveId(object.id, "id"),
      };
    }
    case "report": {
      const object = expectObject(value, ["type", "session", "latencyMs", "jitterMs", "samples"]);
      return {
        type: "report",
        session: expectSessionId(object.session, "session"),
        latencyMs: expectFiniteNumber(object.latencyMs, "latencyMs", 0, 60000),
        jitterMs: expectFiniteNumber(object.jitterMs, "jitterMs", 0, 60000),
        samples: expectBoundedSafeUint(object.samples, "samples", 2, 10),
      };
    }
    case "visibility": {
      const object = expectObject(value, ["type", "session", "hidden"]);
      return {
        type: "visibility",
        session: expectSessionId(object.session, "session"),
        hidden: expectBoolean(object.hidden, "hidden"),
      };
    }
    case "debug":
      return validateClientDebug(value);
    default:
      throw new Error("unknown client message type");
  }
}

function validateClientDebug(value: unknown): WireRecord {
  const object = expectObjectWithType(value);
  if (object.type !== "debug") {
    throw new Error("invalid debug type");
  }
  const session = expectSessionId(object.session, "session");
  switch (object.action) {
    case "forceTier": {
      const command = expectObject(value, ["type", "session", "action", "value"]);
      const forcedValue = command.value === "auto" ? "auto" : expectTier(command.value, "value");
      return { type: "debug", session, action: "forceTier", value: forcedValue };
    }
    case "pongDelay": {
      const command = expectObject(value, ["type", "session", "action", "value"]);
      return {
        type: "debug",
        session,
        action: "pongDelay",
        value: expectBoundedSafeUint(command.value, "value", 0, 4000),
      };
    }
    case "dropNextBookDelta": {
      expectObject(value, ["type", "session", "action"]);
      return { type: "debug", session, action: "dropNextBookDelta" };
    }
    case "disconnect": {
      expectObject(value, ["type", "session", "action"]);
      return { type: "debug", session, action: "disconnect" };
    }
    default:
      throw new Error("unknown debug action");
  }
}

function validateServerMessage(value: unknown): WireRecord {
  const base = expectObjectWithType(value);
  switch (base.type) {
    case "hello": {
      const object = expectObject(value, [
        "type",
        "v",
        "session",
        "symbol",
        "connId",
        "tier",
        "autoTier",
        "forced",
        "hidden",
        "flushMs",
      ]);
      return {
        type: "hello",
        v: expectExactNumber(object.v, 1, "v"),
        session: expectSessionId(object.session, "session"),
        symbol: expectSymbol(object.symbol),
        connId: expectSessionId(object.connId, "connId"),
        tier: expectTier(object.tier, "tier"),
        autoTier: expectTier(object.autoTier, "autoTier"),
        forced: expectNullableTier(object.forced, "forced"),
        hidden: expectBoolean(object.hidden, "hidden"),
        flushMs: expectDuration(object.flushMs, "flushMs"),
      };
    }
    case "subscribed": {
      const object = expectObject(value, ["type", "session", "interval", "requestId"]);
      return {
        type: "subscribed",
        session: expectSessionId(object.session, "session"),
        interval: expectInterval(object.interval, "interval"),
        requestId: expectPositiveId(object.requestId, "requestId"),
      };
    }
    case "pong": {
      const object = expectObject(value, ["type", "session", "id"]);
      return {
        type: "pong",
        session: expectSessionId(object.session, "session"),
        id: expectPositiveId(object.id, "id"),
      };
    }
    case "tier": {
      const object = expectObject(value, [
        "type",
        "session",
        "tier",
        "autoTier",
        "forced",
        "hidden",
        "flushMs",
        "reason",
      ]);
      return {
        type: "tier",
        session: expectSessionId(object.session, "session"),
        tier: expectTier(object.tier, "tier"),
        autoTier: expectTier(object.autoTier, "autoTier"),
        forced: expectNullableTier(object.forced, "forced"),
        hidden: expectBoolean(object.hidden, "hidden"),
        flushMs: expectDuration(object.flushMs, "flushMs"),
        reason: expectDisplayText(object.reason, "reason"),
      };
    }
    case "heartbeat":
      return validateHeartbeat(value);
    case "book_reset": {
      const object = expectObject(value, ["type", "session", "reason"]);
      return {
        type: "book_reset",
        session: expectSessionId(object.session, "session"),
        reason: expectExactString(object.reason, "cursor_expired", "reason"),
      };
    }
    case "candles_reset": {
      const object = expectObject(value, ["type", "session", "interval", "requestId", "reason"]);
      return {
        type: "candles_reset",
        session: expectSessionId(object.session, "session"),
        interval: expectInterval(object.interval, "interval"),
        requestId: expectPositiveId(object.requestId, "requestId"),
        reason: expectExactString(object.reason, "cursor_expired", "reason"),
      };
    }
    case "error": {
      const object = expectObject(value, ["type", "session", "code", "message"]);
      return {
        type: "error",
        session: expectSessionId(object.session, "session"),
        code: expectErrorCode(object.code, "code"),
        message: expectDisplayText(object.message, "message"),
      };
    }
    case "update":
      return validateServerUpdate(value);
    default:
      throw new Error("unknown server message type");
  }
}

function validateHeartbeat(value: unknown): WireRecord {
  const object = expectObject(value, [
    "type",
    "session",
    "marketRev",
    "bookSeq",
    "candleRequestId",
    "candleLatestRev",
    "feedReady",
  ]);
  const candleRequestId = expectNullablePositiveId(object.candleRequestId, "candleRequestId");
  const candleLatestRev = expectNullablePositiveId(object.candleLatestRev, "candleLatestRev");
  if (candleRequestId === null && candleLatestRev !== null) {
    throw new Error("nullable candle head mismatch");
  }

  return {
    type: "heartbeat",
    session: expectSessionId(object.session, "session"),
    marketRev: expectSafeUint(object.marketRev, "marketRev"),
    bookSeq: expectSafeUint(object.bookSeq, "bookSeq"),
    candleRequestId,
    candleLatestRev,
    feedReady: expectBoolean(object.feedReady, "feedReady"),
  };
}

function validateServerUpdate(value: unknown): WireRecord {
  const object = expectObjectAllowOptional(value, ["type", "session", "marketRev"], ["book", "candles", "trades", "skipped"]);
  const marketRev = expectPositiveId(object.marketRev, "marketRev");
  const hasBook = Object.hasOwn(object, "book");
  const hasCandles = Object.hasOwn(object, "candles");
  const hasTrades = Object.hasOwn(object, "trades");
  const hasSkipped = Object.hasOwn(object, "skipped");
  if (!hasBook && !hasCandles && !hasTrades) {
    throw new Error("update missing payload");
  }
  if (hasSkipped !== hasTrades) {
    throw new Error("skipped must match trades");
  }

  const update: WireRecord = {
    type: "update",
    session: expectSessionId(object.session, "session"),
    marketRev,
  };

  if (hasBook) {
    update.book = validateBookRange(object.book);
  }
  if (hasCandles) {
    update.candles = validateCandleBatch(object.candles, marketRev);
  }
  if (hasTrades) {
    const trades = expectArray(object.trades, "trades").map((item) => validateTrade(item, true));
    if (trades.length < 1 || trades.length > 50) {
      throw new Error("invalid update trade count");
    }
    for (let index = 1; index < trades.length; index += 1) {
      if (trades[index - 1].id >= trades[index].id) {
        throw new Error("update trades must ascend by id");
      }
    }
    update.trades = trades;
    update.skipped = expectSafeUint(object.skipped, "skipped");
  }

  return update;
}

function validateBookRange(value: unknown): WireRecord {
  const object = expectObject(value, ["from", "to", "bids", "asks"]);
  const from = expectPositiveId(object.from, "book.from");
  const to = expectPositiveId(object.to, "book.to");
  if (from > to) {
    throw new Error("book range is reversed");
  }
  const bids = validateLevels(object.bids, "book.bids", 0, 4096, false);
  const asks = validateLevels(object.asks, "book.asks", 0, 4096, false);
  const changes = bids.length + asks.length;
  if (changes < 1 || changes > 4096) {
    throw new Error("invalid book range change count");
  }

  return { from, to, bids, asks };
}

function validateCandleBatch(value: unknown, marketRev: number): WireRecord {
  const object = expectObject(value, ["requestId", "interval", "items"]);
  const interval = expectInterval(object.interval, "interval");
  const items = expectArray(object.items, "candles.items").map((item) => validateCandle(item, interval));
  if (items.length < 1 || items.length > 65) {
    throw new Error("invalid candle batch count");
  }
  assertCandlesAscending(items);
  for (const item of items) {
    if ((item.rev as number) > marketRev) {
      throw new Error("candle revision exceeds market revision");
    }
  }

  return {
    requestId: expectPositiveId(object.requestId, "requestId"),
    interval,
    items,
  };
}

function validateCandle(value: unknown, interval: Interval): WireRecord {
  const object = expectObject(value, ["t", "o", "h", "l", "c", "v", "rev", "closed"]);
  const t = expectSafeUint(object.t, "candle.t");
  const open = parsePrice(object.o);
  const high = parsePrice(object.h);
  const low = parsePrice(object.l);
  const close = parsePrice(object.c);
  const volume = parseQuantity(object.v, false);
  assertCandleTimeAligned(t, interval);
  if (
    low.scaled > open.scaled ||
    low.scaled > close.scaled ||
    high.scaled < open.scaled ||
    high.scaled < close.scaled
  ) {
    throw new Error("invalid candle OHLC bounds");
  }
  if (volume.scaled === 0 && !(open.scaled === high.scaled && high.scaled === low.scaled && low.scaled === close.scaled)) {
    throw new Error("invalid zero-volume candle");
  }

  return {
    t,
    o: open.raw,
    h: high.raw,
    l: low.raw,
    c: close.raw,
    v: volume.raw,
    rev: expectPositiveId(object.rev, "candle.rev"),
    closed: expectBoolean(object.closed, "candle.closed"),
  };
}

function validateTrade(
  value: unknown,
  quantityMustBePositive: boolean,
): WireRecord & { id: number; t: number; p: string; q: string; side: string } {
  const object = expectObject(value, ["id", "t", "p", "q", "side"]);

  return {
    id: expectPositiveId(object.id, "trade.id"),
    t: expectSafeUint(object.t, "trade.t"),
    p: parsePrice(object.p).raw,
    q: parseQuantity(object.q, quantityMustBePositive).raw,
    side: expectOneOf(object.side, tradeSides, "trade.side"),
  };
}

function validateLevels(value: unknown, name: string, min: number, max: number, snapshotSort: boolean): [string, string][] {
  const levels = expectArray(value, name);
  if (levels.length < min || levels.length > max) {
    throw new Error(`invalid ${name} length`);
  }

  const seen = new Set<number>();
  const normalized = levels.map((level, index): [string, string] => {
    const tuple = expectArray(level, `${name}.${index}`);
    if (tuple.length !== 2) {
      throw new Error("invalid level tuple");
    }
    const price = parsePrice(tuple[0]);
    const quantity = parseQuantity(tuple[1], snapshotSort);
    if (seen.has(price.scaled)) {
      throw new Error(`duplicate ${name} price`);
    }
    seen.add(price.scaled);
    return [price.raw, quantity.raw];
  });

  if (snapshotSort) {
    assertStrictlySorted(normalized, name);
  }

  return normalized;
}

function assertStrictlySorted(levels: [string, string][], name: string): void {
  const descending = name.includes("bids");
  for (let index = 1; index < levels.length; index += 1) {
    const previous = parsePrice(levels[index - 1][0]).scaled;
    const current = parsePrice(levels[index][0]).scaled;
    if (descending ? previous <= current : previous >= current) {
      throw new Error(`${name} are not sorted`);
    }
  }
}

function assertNonCrossing(bids: [string, string][], asks: [string, string][]): void {
  if (bids.length === 0 || asks.length === 0) {
    return;
  }
  if (parsePrice(bids[0][0]).scaled >= parsePrice(asks[0][0]).scaled) {
    throw new Error("book is crossed");
  }
}

function assertCandlesAscending(candles: WireRecord[]): void {
  for (let index = 1; index < candles.length; index += 1) {
    if ((candles[index - 1].t as number) >= (candles[index].t as number)) {
      throw new Error("candles must ascend by time");
    }
  }
}

function assertCandleTimeAligned(timeMs: number, interval: Interval): void {
  const intervalMs = intervalToMs(interval);
  if (timeMs % intervalMs !== 0) {
    throw new Error("candle time is not aligned");
  }
}

function intervalToMs(interval: Interval): number {
  switch (interval) {
    case "1s":
      return 1000;
    case "1m":
      return 60_000;
    case "5m":
      return 300_000;
  }
}
