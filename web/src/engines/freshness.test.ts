import { describe, expect, it } from "vitest";
import { FreshnessMonitor } from "./freshness";

function monitor() {
  let nowMs = 0;
  const freshness = new FreshnessMonitor({ now: () => nowMs });

  return {
    freshness,
    setNow(value: number) {
      nowMs = value;
    },
    advanceBy(value: number) {
      nowMs += value;
    },
  };
}

describe("FreshnessMonitor transport and producer evidence", () => {
  it("marks visible transport silence stale after 10 seconds", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.transportReceived(1);
    setNow(9_999);
    const beforeLimit = freshness.advance();
    setNow(10_000);
    const atLimit = freshness.advance();

    expect(beforeLimit.reconnect).toBeUndefined();
    expect(atLimit.reconnect).toEqual({ epoch: 1, reason: "transport_silence" });
    expect(freshness.getState().condition).toBe("stale");
  });

  it("marks producer progress feed-delayed after 5 seconds even when pongs continue", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.heartbeat({ epoch: 1, marketRev: 7, flushMs: 500 });
    setNow(4_999);
    freshness.transportReceived(1);
    const beforeLimit = freshness.advance();
    setNow(5_000);
    freshness.transportReceived(1);
    const atLimit = freshness.advance();

    expect(beforeLimit.markFeedDelayed).toBeUndefined();
    expect(atLimit.markFeedDelayed).toEqual({ epoch: 1, delayed: true });
    expect(freshness.getState().condition).toBe("feed-delayed");
  });

  it("suspends hidden freshness alarms and clears old evidence on visible return", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.transportReceived(1);
    freshness.heartbeat({ epoch: 1, marketRev: 1, flushMs: 500 });
    freshness.visibilityChanged(true);
    setNow(20_000);
    const hiddenAdvance = freshness.advance();
    const visibleAgain = freshness.visibilityChanged(false);

    expect(hiddenAdvance).toEqual({});
    expect(visibleAgain.clearEvidence).toEqual({ epoch: 1 });
    expect(freshness.getState()).toMatchObject({
      condition: "waiting",
      lastTransportAtMs: null,
      lastMarketRev: null,
    });
  });

  it("ignores old epoch transport and heartbeat evidence", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(2);
    freshness.transportReceived(1);
    freshness.heartbeat({ epoch: 1, marketRev: 99, flushMs: 500 });
    setNow(10_000);
    const effects = freshness.advance();

    expect(effects.reconnect).toBeUndefined();
    expect(freshness.getState()).toMatchObject({
      epoch: 2,
      lastTransportAtMs: null,
      lastMarketRev: null,
    });
  });
});

describe("FreshnessMonitor panel head resync", () => {
  it("resyncs a panel when payload delivery is stuck for the larger of 5 seconds and three flush intervals", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.panelApplied({ epoch: 1, panel: "book", head: 100 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 1,
      flushMs: 500,
      advertisedHeads: { bookSeq: 120 },
    });
    setNow(4_999);
    const beforeLimit = freshness.advance();
    setNow(5_000);
    const atLimit = freshness.advance();

    expect(beforeLimit.resyncPanel).toBeUndefined();
    expect(atLimit.resyncPanel).toEqual({
      epoch: 1,
      panel: "book",
      reason: "advertised_head_stalled",
    });
  });

  it("uses three flush intervals when that threshold is larger than 5 seconds", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.panelApplied({ epoch: 1, panel: "book", head: 100 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 1,
      flushMs: 2_500,
      advertisedHeads: { bookSeq: 120 },
    });
    setNow(7_499);
    const beforeLimit = freshness.advance();
    setNow(7_500);
    const atLimit = freshness.advance();

    expect(beforeLimit.resyncPanel).toBeUndefined();
    expect(atLimit.resyncPanel).toEqual({
      epoch: 1,
      panel: "book",
      reason: "advertised_head_stalled",
    });
  });

  it("does not resync merely because a progressing consumer remains behind an advancing producer", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.panelApplied({ epoch: 1, panel: "book", head: 100 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 1,
      flushMs: 500,
      advertisedHeads: { bookSeq: 120 },
    });
    setNow(4_000);
    freshness.panelApplied({ epoch: 1, panel: "book", head: 110 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 2,
      flushMs: 500,
      advertisedHeads: { bookSeq: 130 },
    });
    setNow(8_999);
    const effects = freshness.advance();

    expect(effects.resyncPanel).toBeUndefined();
  });

  it("resyncs only after the local head stops progressing while the advertised head stays ahead", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.panelApplied({ epoch: 1, panel: "book", head: 100 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 1,
      flushMs: 500,
      advertisedHeads: { bookSeq: 120 },
    });
    setNow(4_000);
    freshness.panelApplied({ epoch: 1, panel: "book", head: 110 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 2,
      flushMs: 500,
      advertisedHeads: { bookSeq: 130 },
    });
    setNow(9_000);
    const effects = freshness.advance();

    expect(effects.resyncPanel).toEqual({
      epoch: 1,
      panel: "book",
      reason: "advertised_head_stalled",
    });
  });

  it("waits a full stall interval after the advertised head first moves ahead", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.transportReceived(1);
    freshness.panelApplied({ epoch: 1, panel: "book", head: 100 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 1,
      flushMs: 500,
      advertisedHeads: { bookSeq: 100 },
    });
    setNow(6_000);
    freshness.transportReceived(1);
    freshness.heartbeat({
      epoch: 1,
      marketRev: 2,
      flushMs: 500,
      advertisedHeads: { bookSeq: 120 },
    });
    const immediate = freshness.advance();
    setNow(10_999);
    const beforeLimit = freshness.advance();
    setNow(11_000);
    const atLimit = freshness.advance();

    expect(immediate.resyncPanel).toBeUndefined();
    expect(beforeLimit.resyncPanel).toBeUndefined();
    expect(atLimit.resyncPanel).toEqual({
      epoch: 1,
      panel: "book",
      reason: "advertised_head_stalled",
    });
  });

  it("clears panel stall tracking after the local head catches up", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.transportReceived(1);
    freshness.panelApplied({ epoch: 1, panel: "book", head: 100 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 1,
      flushMs: 500,
      advertisedHeads: { bookSeq: 130 },
    });
    setNow(4_000);
    freshness.panelApplied({ epoch: 1, panel: "book", head: 130 });
    setNow(20_000);
    freshness.transportReceived(1);
    freshness.heartbeat({
      epoch: 1,
      marketRev: 2,
      flushMs: 500,
      advertisedHeads: { bookSeq: 130 },
    });
    const caughtUp = freshness.advance();
    setNow(21_000);
    freshness.heartbeat({
      epoch: 1,
      marketRev: 3,
      flushMs: 500,
      advertisedHeads: { bookSeq: 140 },
    });
    const firstAheadAgain = freshness.advance();
    setNow(25_999);
    const beforeLimit = freshness.advance();
    setNow(26_000);
    const atLimit = freshness.advance();

    expect(caughtUp.resyncPanel).toBeUndefined();
    expect(firstAheadAgain.resyncPanel).toBeUndefined();
    expect(beforeLimit.resyncPanel).toBeUndefined();
    expect(atLimit.resyncPanel).toEqual({
      epoch: 1,
      panel: "book",
      reason: "advertised_head_stalled",
    });
  });

  it("ignores candle advertised heads for a noncurrent request ID", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.selectedCandleRequest(7);
    freshness.panelApplied({ epoch: 1, panel: "candles", requestId: 7, head: 10 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 1,
      flushMs: 500,
      advertisedHeads: { candle: { requestId: 6, revision: 99 } },
    });
    setNow(20_000);
    const effects = freshness.advance();

    expect(effects.resyncPanel).toBeUndefined();
  });

  it("resyncs candles when the current selected candle head stalls at the threshold", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.selectedCandleRequest(7);
    freshness.panelApplied({ epoch: 1, panel: "candles", requestId: 7, head: 10 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 1,
      flushMs: 500,
      advertisedHeads: { candle: { requestId: 7, revision: 12 } },
    });
    setNow(4_999);
    const beforeLimit = freshness.advance();
    setNow(5_000);
    const atLimit = freshness.advance();

    expect(beforeLimit.resyncPanel).toBeUndefined();
    expect(atLimit.resyncPanel).toEqual({
      epoch: 1,
      panel: "candles",
      reason: "advertised_head_stalled",
    });
  });

  it("ignores candle applied progress without the current selected request ID", () => {
    const { freshness, setNow } = monitor();

    freshness.reset(1);
    freshness.selectedCandleRequest(7);
    freshness.panelApplied({ epoch: 1, panel: "candles", requestId: 7, head: 10 });
    freshness.heartbeat({
      epoch: 1,
      marketRev: 1,
      flushMs: 500,
      advertisedHeads: { candle: { requestId: 7, revision: 12 } },
    });
    setNow(4_000);
    freshness.panelApplied({
      epoch: 1,
      panel: "candles",
      head: 11,
    } as unknown as Parameters<FreshnessMonitor["panelApplied"]>[0]);
    freshness.panelApplied({
      epoch: 1,
      panel: "candles",
      requestId: 6,
      head: 12,
    } as unknown as Parameters<FreshnessMonitor["panelApplied"]>[0]);
    setNow(4_999);
    const beforeLimit = freshness.advance();
    setNow(5_000);
    const atLimit = freshness.advance();

    expect(beforeLimit.resyncPanel).toBeUndefined();
    expect(atLimit.resyncPanel).toEqual({
      epoch: 1,
      panel: "candles",
      reason: "advertised_head_stalled",
    });
  });
});
