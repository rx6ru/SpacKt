import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WireRecord } from "./support";
import { decodeWire } from "./schema";
import {
  mapBookSnapshot,
  mapHistory,
  mapHttpError,
  mapMeta,
  mapRecentTrades,
  mapServerEvent,
} from "./mapping";

const fixtureRoot = join(process.cwd(), "..", "protocol", "fixtures");

function readFixture(file: string): string {
  return readFileSync(join(fixtureRoot, file), "utf8");
}

function decode(kind: string, value: Record<string, unknown>): WireRecord {
  return decodeWire(kind, JSON.stringify(value));
}

function decodeFixture(kind: string, file: string): WireRecord {
  return decodeWire(kind, readFixture(file));
}

function tenBookLevels(startPriceCents: number, side: "bid" | "ask"): string[][] {
  return Array.from({ length: 10 }, (_value, index) => {
    const cents = side === "bid" ? startPriceCents - index : startPriceCents + index;
    return [(cents / 100).toFixed(2), "1.0000"];
  });
}

const candleWire = {
  t: 1_700_000_000_000,
  o: "0.29",
  h: "1.23",
  l: "0.28",
  c: "1.00",
  v: "0.0007",
  rev: 84,
  closed: true,
};

const candleDomain = {
  timeMs: 1_700_000_000_000,
  openTicks: 29,
  highTicks: 123,
  lowTicks: 28,
  closeTicks: 100,
  volumeLots: 7,
  rev: 84,
  closed: true,
};

describe("wire domain mapping", () => {
  it("accepts and preserves every equal-time execution in an ordered trade batch", () => {
    const mapped = mapServerEvent(decode("server", {
      type: "update",
      session: "s1",
      marketRev: 84,
      trades: [
        { id: 41, t: 1700000000800, p: "101.00", q: "0.2000", side: "buy" },
        { id: 42, t: 1700000000800, p: "101.00", q: "0.2000", side: "buy" },
        { id: 43, t: 1700000000800, p: "102.00", q: "0.2000", side: "buy" },
      ],
      skipped: 0,
    }), 321);

    expect(mapped).toMatchObject({
      type: "update",
      trades: [
        { id: 41, timeMs: 1700000000800, priceTicks: 10100, quantityLots: 2000, side: "buy" },
        { id: 42, timeMs: 1700000000800, priceTicks: 10100, quantityLots: 2000, side: "buy" },
        { id: 43, timeMs: 1700000000800, priceTicks: 10200, quantityLots: 2000, side: "buy" },
      ],
      skipped: 0,
    });
  });

  it("maps metadata policy and retention without dropping public fields", () => {
    const mapped = mapMeta(decodeFixture("meta", "valid-meta.json"));

    expect(mapped).toEqual({
      session: "s1",
      symbol: "BTC-USD",
      tickSize: "0.01",
      lotSize: "0.0001",
      intervals: ["1s", "1m", "5m"],
      referencePriceTicks: 6_400_000,
      tierPolicy: {
        initialTier: "degraded",
        flushMs: { full: 100, degraded: 500, minimal: 2000 },
        enterDegraded: { latencyAboveMs: 400, jitterAboveMs: 60 },
        enterMinimal: { latencyAboveMs: 900, jitterAboveMs: 150 },
        recoverFull: { latencyBelowMs: 300, jitterBelowMs: 40 },
        recoverDegraded: { latencyBelowMs: 700, jitterBelowMs: 100 },
        downgradeDwellMs: 3000,
        upgradeDwellMs: 10000,
        missingReportStepMs: 5000,
        missingReportMinimalMs: 12000,
        pingEveryMs: 1000,
        pongTimeoutMs: 3000,
        reportEveryMs: 2000,
        rttWindowSamples: 10,
        minimumReportSamples: 2,
        hiddenCloseMs: 180000,
      },
      retention: {
        historyCandles: { "1s": 3600, "1m": 1440, "5m": 2016 },
        deliveryClosedCandles: 64,
        recentTrades: 200,
        bookChanges: 4096,
        maximumBookLevelsPerSide: 50,
      },
    });
  });

  it("maps book snapshot prices to cents and quantities to lots exactly", () => {
    const wire = decode("book", {
      session: "s1",
      symbol: "BTC-USD",
      seq: 102,
      t: 1_700_000_000_100,
      bids: [["0.29", "0.0003"], ...tenBookLevels(28, "bid").slice(0, 9)],
      asks: [["1.00", "0.0004"], ...tenBookLevels(101, "ask").slice(0, 9)],
    });

    expect(mapBookSnapshot(wire)).toEqual({
      session: "s1",
      symbol: "BTC-USD",
      seq: 102,
      timeMs: 1_700_000_000_100,
      bids: [
        { priceTicks: 29, quantityLots: 3 },
        { priceTicks: 28, quantityLots: 10000 },
        { priceTicks: 27, quantityLots: 10000 },
        { priceTicks: 26, quantityLots: 10000 },
        { priceTicks: 25, quantityLots: 10000 },
        { priceTicks: 24, quantityLots: 10000 },
        { priceTicks: 23, quantityLots: 10000 },
        { priceTicks: 22, quantityLots: 10000 },
        { priceTicks: 21, quantityLots: 10000 },
        { priceTicks: 20, quantityLots: 10000 },
      ],
      asks: [
        { priceTicks: 100, quantityLots: 4 },
        { priceTicks: 101, quantityLots: 10000 },
        { priceTicks: 102, quantityLots: 10000 },
        { priceTicks: 103, quantityLots: 10000 },
        { priceTicks: 104, quantityLots: 10000 },
        { priceTicks: 105, quantityLots: 10000 },
        { priceTicks: 106, quantityLots: 10000 },
        { priceTicks: 107, quantityLots: 10000 },
        { priceTicks: 108, quantityLots: 10000 },
        { priceTicks: 109, quantityLots: 10000 },
      ],
    });
  });

  it("does not alias mapped book levels to caller-owned wire arrays", () => {
    const wire = decode("book", {
      session: "s1",
      symbol: "BTC-USD",
      seq: 102,
      t: 1_700_000_000_100,
      bids: [["0.29", "0.0003"], ...tenBookLevels(28, "bid").slice(0, 9)],
      asks: [["1.00", "0.0004"], ...tenBookLevels(101, "ask").slice(0, 9)],
    });
    const mapped = mapBookSnapshot(wire);

    ((wire.bids as unknown[][])[0] as string[])[0] = "0.28";
    ((wire.asks as unknown[][])[0] as string[])[1] = "0.0005";

    expect(mapped.bids[0]).toEqual({ priceTicks: 29, quantityLots: 3 });
    expect(mapped.asks[0]).toEqual({ priceTicks: 100, quantityLots: 4 });
  });

  it("maps history candles with request identity, revision, close state, and time", () => {
    const mapped = mapHistory(decode("history", {
      session: "s1",
      symbol: "BTC-USD",
      interval: "1s",
      requestId: 7,
      candles: [candleWire],
    }));

    expect(mapped).toEqual({
      session: "s1",
      symbol: "BTC-USD",
      interval: "1s",
      requestId: 7,
      candles: [candleDomain],
    });
  });

  it("maps recent trades to exact integer prices and quantities", () => {
    const mapped = mapRecentTrades(decode("trades", {
      session: "s1",
      symbol: "BTC-USD",
      trades: [{ id: 9, t: 1_700_000_000_900, p: "0.29", q: "0.0003", side: "buy" }],
    }));

    expect(mapped).toEqual({
      session: "s1",
      symbol: "BTC-USD",
      trades: [{ id: 9, timeMs: 1_700_000_000_900, priceTicks: 29, quantityLots: 3, side: "buy" }],
    });
  });

  it("maps update book removals, candle batches, trades, skipped count, and wire byte count", () => {
    const mapped = mapServerEvent(decode("server", {
      type: "update",
      session: "s1",
      marketRev: 84,
      book: {
        from: 101,
        to: 104,
        bids: [["0.29", "0"]],
        asks: [["1.23", "0.0004"]],
      },
      candles: {
        requestId: 7,
        interval: "1s",
        items: [candleWire],
      },
      trades: [{ id: 8, t: 1_700_000_000_800, p: "0.29", q: "0.0003", side: "sell" }],
      skipped: 2,
    }), 1234);

    expect(mapped).toEqual({
      type: "update",
      session: "s1",
      marketRev: 84,
      book: {
        from: 101,
        to: 104,
        bids: [{ priceTicks: 29, quantityLots: 0 }],
        asks: [{ priceTicks: 123, quantityLots: 4 }],
      },
      candles: {
        requestId: 7,
        interval: "1s",
        items: [candleDomain],
      },
      trades: [{ id: 8, timeMs: 1_700_000_000_800, priceTicks: 29, quantityLots: 3, side: "sell" }],
      skipped: 2,
      wireBytes: 1234,
    });
  });

  it.each([
    ["hello", "valid-server-hello.json", 10, {
      type: "hello",
      session: "s1",
      symbol: "BTC-USD",
      protocolVersion: 1,
      connId: "c1",
      tier: "degraded",
      autoTier: "degraded",
      forced: null,
      hidden: false,
      flushMs: 500,
    }],
    ["subscribed", "valid-server-subscribed.json", 20, { type: "subscribed", session: "s1", interval: "1s", requestId: 1 }],
    ["pong", "valid-server-pong.json", 30, { type: "pong", session: "s1", id: 1 }],
    ["tier", "valid-server-tier.json", 40, {
      type: "tier",
      session: "s1",
      tier: "minimal",
      autoTier: "degraded",
      forced: "minimal",
      hidden: false,
      flushMs: 2000,
      reason: "Debug tier forced.",
    }],
    ["heartbeat", "valid-server-heartbeat.json", 50, {
      type: "heartbeat",
      session: "s1",
      marketRev: 84,
      bookSeq: 104,
      candleRequestId: null,
      candleLatestRev: null,
      feedReady: true,
    }],
    ["book reset", "valid-server-book-reset.json", 60, { type: "book_reset", session: "s1", reason: "cursor_expired" }],
    ["candles reset", "valid-server-candles-reset.json", 70, { type: "candles_reset", session: "s1", interval: "1s", requestId: 1, reason: "cursor_expired" }],
    ["server error", "valid-server-error.json", 80, { type: "error", session: "s1", code: "bad_message", message: "Malformed message." }],
  ] as const)("maps server %s control event", (_name, file, wireBytes, expected) => {
    expect(mapServerEvent(decodeFixture("server", file), wireBytes)).toEqual(expected);
  });

  it("maps heartbeat with non-null candle heads", () => {
    expect(mapServerEvent(decode("server", {
      type: "heartbeat",
      session: "s1",
      marketRev: 84,
      bookSeq: 104,
      candleRequestId: 7,
      candleLatestRev: 83,
      feedReady: false,
    }), 111)).toEqual({
      type: "heartbeat",
      session: "s1",
      marketRev: 84,
      bookSeq: 104,
      candleRequestId: 7,
      candleLatestRev: 83,
      feedReady: false,
    });
  });

  it("maps HTTP error envelopes without changing the public error payload", () => {
    expect(mapHttpError(decodeFixture("httpError", "valid-http-error.json"))).toEqual({
      error: { code: "bad_request", message: "Invalid request." },
    });
  });

  it.each([
    ["meta", "valid-meta.json", (value: WireRecord) => mapMeta(value)],
    ["book", "valid-book.json", (value: WireRecord) => mapBookSnapshot(value)],
    ["history", "valid-history.json", (value: WireRecord) => mapHistory(value)],
    ["trades", "valid-trades.json", (value: WireRecord) => mapRecentTrades(value)],
    ["httpError", "valid-http-error.json", (value: WireRecord) => mapHttpError(value)],
    ["server", "valid-server-hello.json", (value: WireRecord) => mapServerEvent(value, readFixture("valid-server-hello.json").length)],
    ["server", "valid-server-subscribed.json", (value: WireRecord) => mapServerEvent(value, readFixture("valid-server-subscribed.json").length)],
    ["server", "valid-server-pong.json", (value: WireRecord) => mapServerEvent(value, readFixture("valid-server-pong.json").length)],
    ["server", "valid-server-tier.json", (value: WireRecord) => mapServerEvent(value, readFixture("valid-server-tier.json").length)],
    ["server", "valid-server-heartbeat.json", (value: WireRecord) => mapServerEvent(value, readFixture("valid-server-heartbeat.json").length)],
    ["server", "valid-server-book-reset.json", (value: WireRecord) => mapServerEvent(value, readFixture("valid-server-book-reset.json").length)],
    ["server", "valid-server-candles-reset.json", (value: WireRecord) => mapServerEvent(value, readFixture("valid-server-candles-reset.json").length)],
    ["server", "valid-server-error.json", (value: WireRecord) => mapServerEvent(value, readFixture("valid-server-error.json").length)],
    ["server", "valid-server-update.json", (value: WireRecord) => mapServerEvent(value, readFixture("valid-server-update.json").length)],
  ] as const)("maps shared public fixture %s/%s", (kind, file, mapper) => {
    expect(() => mapper(decodeFixture(kind, file))).not.toThrow();
  });
});
