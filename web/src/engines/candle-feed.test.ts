import { describe, expect, it } from "vitest";
import { CandleFeed } from "./candle-feed";

const candle = (
  timeMs: number,
  rev: number,
  closeTicks: number,
  overrides: Partial<{
    openTicks: number;
    highTicks: number;
    lowTicks: number;
    volumeLots: number;
    closed: boolean;
  }> = {},
) => ({
  timeMs,
  openTicks: overrides.openTicks ?? closeTicks,
  highTicks: overrides.highTicks ?? closeTicks,
  lowTicks: overrides.lowTicks ?? closeTicks,
  closeTicks,
  volumeLots: overrides.volumeLots ?? 0,
  rev,
  closed: overrides.closed ?? false,
});

describe("CandleFeed", () => {
  it("reset records the authoritative session and clears local candle state", () => {
    const feed = new CandleFeed();

    feed.reset("s1");
    feed.select("1s", 3);
    feed.receiveLive({ session: "s1", interval: "1s", requestId: 3, items: [candle(1000, 1, 10100)] });

    feed.reset("s2");

    expect(feed.getState()).toMatchObject({
      session: "s2",
      interval: null,
      requestId: null,
      generation: 3,
      status: "idle",
      candles: [],
    });
  });

  it("ignores old-session history even when interval and request ID match", () => {
    const feed = new CandleFeed();

    feed.reset("s2");
    const selection = feed.select("1s", 7);
    const effects = feed.receiveHistory(
      { session: "s1", interval: "1s", requestId: 7, candles: [candle(1000, 1, 10100)] },
      selection.fetchHistory!.generation,
    );

    expect(effects).toEqual({});
    expect(feed.getState()).toMatchObject({
      session: "s2",
      status: "loading",
      candles: [],
    });
  });

  it("ignores old-session live candles even when interval and request ID match", () => {
    const feed = new CandleFeed();

    feed.reset("s2");
    feed.select("1s", 7);
    const effects = feed.receiveLive({
      session: "s1",
      interval: "1s",
      requestId: 7,
      items: [candle(1000, 1, 10100)],
    });

    expect(effects).toEqual({});
    expect(feed.getState()).toMatchObject({
      session: "s2",
      status: "loading",
      candles: [],
    });
  });

  it("drops a late history response for an obsolete interval generation", () => {
    const feed = new CandleFeed();

    feed.reset("s1");
    const firstSelection = feed.select("1m", 7);
    feed.select("5m", 8);
    const effects = feed.receiveHistory(
      { session: "s1", interval: "1m", requestId: 7, candles: [candle(0, 1, 10000)] },
      firstSelection.fetchHistory!.generation,
    );

    expect(effects).toEqual({});
    expect(feed.getState()).toMatchObject({
      interval: "5m",
      requestId: 8,
      generation: 3,
      status: "loading",
      candles: [],
    });
  });

  it("keeps a newer live revision over a late history candle for the same key", () => {
    const feed = new CandleFeed();

    feed.reset("s1");
    const selection = feed.select("1s", 3);
    feed.receiveLive({ session: "s1", interval: "1s", requestId: 3, items: [candle(1000, 84, 10400)] });
    feed.receiveHistory(
      { session: "s1", interval: "1s", requestId: 3, candles: [candle(1000, 80, 10000)] },
      selection.fetchHistory!.generation,
    );

    expect(feed.getState().candles).toEqual([candle(1000, 84, 10400)]);
  });

  it("marks the stream invalid and requests resync on equal revision value conflict", () => {
    const feed = new CandleFeed();

    feed.reset("s1");
    feed.select("1s", 3);
    feed.receiveLive({ session: "s1", interval: "1s", requestId: 3, items: [candle(1000, 84, 10400)] });
    const effects = feed.receiveLive({
      session: "s1",
      interval: "1s",
      requestId: 3,
      items: [candle(1000, 84, 10500)],
    });

    expect(effects).toEqual({ resync: { interval: "1s", requestId: 3, reason: "equal_rev_conflict" } });
    expect(feed.getState()).toMatchObject({ status: "invalid" });
  });

  it("recovers from an equal revision conflict with a same-interval selection using a new request ID", () => {
    const feed = new CandleFeed();

    feed.reset("s1");
    const oldSelection = feed.select("1s", 3);
    feed.receiveLive({ session: "s1", interval: "1s", requestId: 3, items: [candle(1000, 84, 10400)] });
    const conflict = feed.receiveLive({
      session: "s1",
      interval: "1s",
      requestId: 3,
      items: [candle(1000, 84, 10500)],
    });

    expect(conflict).toEqual({ resync: { interval: "1s", requestId: 3, reason: "equal_rev_conflict" } });

    const newSelection = feed.select("1s", 4);

    expect(newSelection).toEqual({ fetchHistory: { interval: "1s", requestId: 4, generation: 3 } });

    expect(
      feed.receiveHistory(
        { session: "s1", interval: "1s", requestId: 3, candles: [candle(1000, 90, 10900)] },
        oldSelection.fetchHistory!.generation,
      ),
    ).toEqual({});
    expect(
      feed.receiveLive({ session: "s1", interval: "1s", requestId: 3, items: [candle(1000, 91, 11000)] }),
    ).toEqual({});
    expect(
      feed.receiveHistory(
        { session: "s1", interval: "1s", requestId: 4, candles: [candle(1000, 92, 11100)] },
        newSelection.fetchHistory!.generation,
      ),
    ).toEqual({});

    expect(feed.getState()).toMatchObject({
      interval: "1s",
      requestId: 4,
      generation: 3,
      status: "ready",
      candles: [candle(1000, 92, 11100)],
    });
  });

  it("loads empty history as ready and then displays the first current live candle", () => {
    const feed = new CandleFeed();

    feed.reset("s1");
    const selection = feed.select("1s", 5);
    feed.receiveHistory({ session: "s1", interval: "1s", requestId: 5, candles: [] }, selection.fetchHistory!.generation);

    expect(feed.getState()).toMatchObject({ status: "ready", candles: [] });

    feed.receiveLive({ session: "s1", interval: "1s", requestId: 5, items: [candle(1000, 1, 10100)] });

    expect(feed.getState()).toMatchObject({
      status: "ready",
      candles: [candle(1000, 1, 10100)],
    });
  });

  it("exposes candles sorted by time when live candles arrive out of order", () => {
    const feed = new CandleFeed();

    feed.reset("s1");
    feed.select("1s", 5);
    feed.receiveLive({
      session: "s1",
      interval: "1s",
      requestId: 5,
      items: [candle(3000, 3, 10300), candle(2000, 2, 10200)],
    });

    expect(feed.getState().candles.map((item) => item.timeMs)).toEqual([2000, 3000]);
  });

  it("rejects an obsolete A message after an A to B to A selection sequence", () => {
    const feed = new CandleFeed();

    feed.reset("s1");
    feed.select("1s", 1);
    feed.select("1m", 2);
    feed.select("1s", 3);
    feed.receiveLive({ session: "s1", interval: "1s", requestId: 1, items: [candle(1000, 1, 10100)] });

    expect(feed.getState()).toMatchObject({
      interval: "1s",
      requestId: 3,
      candles: [],
    });
  });
});
