import { describe, expect, it } from "vitest";
import { BookSync } from "./book-sync";

type Level = { priceTicks: number; quantityLots: number };

const bids = (...levels: Array<[number, number]>): Level[] =>
  levels.map(([priceTicks, quantityLots]) => ({ priceTicks, quantityLots }));

const asks = (...levels: Array<[number, number]>): Level[] =>
  levels.map(([priceTicks, quantityLots]) => ({ priceTicks, quantityLots }));

const padBids = (foreground: Level[]): Level[] => {
  const prices = new Set(foreground.map((level) => level.priceTicks));
  const padded = [...foreground];

  for (let priceTicks = 9000; padded.length < 10; priceTicks -= 1) {
    if (!prices.has(priceTicks)) {
      padded.push({ priceTicks, quantityLots: 10 });
    }
  }

  return padded;
};

const padAsks = (foreground: Level[]): Level[] => {
  const prices = new Set(foreground.map((level) => level.priceTicks));
  const padded = [...foreground];

  for (let priceTicks = 11000; padded.length < 10; priceTicks += 1) {
    if (!prices.has(priceTicks)) {
      padded.push({ priceTicks, quantityLots: 10 });
    }
  }

  return padded;
};

const snapshot = (session: string, seq: number, foregroundBids: Level[], foregroundAsks: Level[]) => ({
  session,
  seq,
  bids: padBids(foregroundBids),
  asks: padAsks(foregroundAsks),
});

const expectValidDepth = (book: { bids: Level[]; asks: Level[] }) => {
  expect(book.bids.length).toBeGreaterThanOrEqual(10);
  expect(book.bids.length).toBeLessThanOrEqual(50);
  expect(book.asks.length).toBeGreaterThanOrEqual(10);
  expect(book.asks.length).toBeLessThanOrEqual(50);
};

const expectLevel = (levels: Level[], priceTicks: number, quantityLots: number) => {
  expect(levels.find((level) => level.priceTicks === priceTicks)).toEqual({ priceTicks, quantityLots });
};

const prices = (levels: Level[]) => levels.map((level) => level.priceTicks);

describe("BookSync", () => {
  it("accepts a complete ten-by-ten snapshot at sequence zero", () => {
    const sync = new BookSync();
    const snapshotAtStart = {
      session: "s1",
      seq: 0,
      bids: bids(
        [10000, 100],
        [9999, 100],
        [9998, 100],
        [9997, 100],
        [9996, 100],
        [9995, 100],
        [9994, 100],
        [9993, 100],
        [9992, 100],
        [9991, 100],
      ),
      asks: asks(
        [10001, 100],
        [10002, 100],
        [10003, 100],
        [10004, 100],
        [10005, 100],
        [10006, 100],
        [10007, 100],
        [10008, 100],
        [10009, 100],
        [10010, 100],
      ),
    };

    sync.start("s1", 0);
    const effects = sync.receiveSnapshot(snapshotAtStart, 1, 10);

    expect(effects).toEqual({});
    const state = sync.getState();
    expect(state).toMatchObject({
      session: "s1",
      status: "synced",
      generation: 1,
      expectedSeq: 1,
    });
    expect(state.book.bids).toEqual(snapshotAtStart.bids);
    expect(state.book.asks).toEqual(snapshotAtStart.asks);
  });

  it("buffers ranges during a snapshot request and replays the overlapping suffix", () => {
    const sync = new BookSync();

    expect(sync.start("s1", 0)).toEqual({ fetchSnapshot: { generation: 1, delayMs: 0 } });
    sync.receiveRange({ session: "s1", from: 50232, to: 50234, bids: bids([10000, 100]), asks: [] }, 10);
    sync.receiveRange({ session: "s1", from: 50235, to: 50238, bids: bids([9999, 200]), asks: [] }, 20);

    const effects = sync.receiveSnapshot(snapshot("s1", 50236, bids([10000, 300]), asks([10001, 400])), 1, 30);

    expect(effects).toEqual({});
    const state = sync.getState();
    expect(state).toMatchObject({
      status: "synced",
      generation: 1,
      expectedSeq: 50239,
      bufferedRanges: 0,
    });
    expectValidDepth(state.book);
    expectLevel(state.book.bids, 10000, 300);
    expectLevel(state.book.bids, 9999, 200);
    expectLevel(state.book.asks, 10001, 400);
  });

  it("requests a newer snapshot when the accepted snapshot is older than the first buffered range", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveRange({ session: "s1", from: 120, to: 125, bids: bids([10000, 111]), asks: [] }, 10);

    const effects = sync.receiveSnapshot(snapshot("s1", 110, bids([9999, 222]), asks([10001, 333])), 1, 20);

    expect(effects).toEqual({ fetchSnapshot: { generation: 2, delayMs: 500 } });
    expect(sync.getState()).toMatchObject({
      status: "buffering",
      generation: 2,
      expectedSeq: null,
      attemptsUsed: 2,
      book: { bids: [], asks: [] },
    });
  });

  it("ignores an already-covered duplicate range", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 199, bids([10000, 100]), asks([10001, 100])), 1, 10);

    const effects = sync.receiveRange({ session: "s1", from: 190, to: 199, bids: bids([10000, 999]), asks: [] }, 20);

    expect(effects).toEqual({});
    const state = sync.getState();
    expect(state).toMatchObject({
      status: "synced",
      expectedSeq: 200,
    });
    expectValidDepth(state.book);
    expectLevel(state.book.bids, 10000, 100);
  });

  it("requests a fresh snapshot when a range has a sequence gap after valid sync", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 199, bids([10000, 100]), asks([10001, 100])), 1, 10);

    const effects = sync.receiveRange({ session: "s1", from: 201, to: 205, bids: bids([9999, 200]), asks: [] }, 20);

    expect(effects).toEqual({ fetchSnapshot: { generation: 2, delayMs: 0 } });
    const state = sync.getState();
    expect(state).toMatchObject({
      status: "buffering",
      generation: 2,
      expectedSeq: 200,
      attemptsUsed: 1,
    });
    expectValidDepth(state.book);
    expectLevel(state.book.bids, 10000, 100);
  });

  it("applies an overlapping range even when a level reverses to an older visible size", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveRange({ session: "s1", from: 99, to: 101, bids: bids([10000, 100]), asks: [] }, 10);
    sync.receiveSnapshot(snapshot("s1", 100, bids([10000, 200]), asks([10001, 100])), 1, 20);

    const state = sync.getState();
    expect(state).toMatchObject({
      status: "synced",
      expectedSeq: 102,
    });
    expectValidDepth(state.book);
    expectLevel(state.book.bids, 10000, 100);
  });

  it("accepts unsorted unique range levels and publishes a sorted book", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 10, bids([10000, 100]), asks([10010, 100])), 1, 10);

    const effects = sync.receiveRange(
      {
        session: "s1",
        from: 11,
        to: 14,
        bids: bids([9998, 300], [10001, 200]),
        asks: asks([10004, 400], [10002, 500]),
      },
      20,
    );

    expect(effects).toEqual({});
    const state = sync.getState();
    expect(state).toMatchObject({
      status: "synced",
      expectedSeq: 15,
    });
    expect(prices(state.book.bids)).toEqual([...prices(state.book.bids)].sort((left, right) => right - left));
    expect(prices(state.book.asks)).toEqual([...prices(state.book.asks)].sort((left, right) => left - right));
    expectLevel(state.book.bids, 10001, 200);
    expectLevel(state.book.bids, 9998, 300);
    expectLevel(state.book.asks, 10002, 500);
    expectLevel(state.book.asks, 10004, 400);
  });

  it("accepts a range that crosses temporarily but is non-crossing after the whole range", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 10, bids([10000, 100]), asks([10005, 100])), 1, 10);

    const effects = sync.receiveRange(
      {
        session: "s1",
        from: 11,
        to: 12,
        bids: bids([10006, 200]),
        asks: asks([10005, 0], [10007, 300]),
      },
      20,
    );

    expect(effects).toEqual({});
    const state = sync.getState();
    expect(state).toMatchObject({
      status: "synced",
      expectedSeq: 13,
    });
    expectLevel(state.book.bids, 10006, 200);
    expect(state.book.asks.find((level) => level.priceTicks === 10005)).toBeUndefined();
    expectLevel(state.book.asks, 10007, 300);
    expect(state.book.asks[0]?.priceTicks).toBeGreaterThan(10006);
  });

  it("rejects a range that leaves the final book crossed and preserves the last published book", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 10, bids([10000, 100]), asks([10005, 100])), 1, 10);

    const effects = sync.receiveRange({ session: "s1", from: 11, to: 11, bids: bids([10006, 200]), asks: [] }, 20);

    expect(effects).toEqual({ fetchSnapshot: { generation: 2, delayMs: 0 } });
    const state = sync.getState();
    expect(state).toMatchObject({
      status: "buffering",
      generation: 2,
      expectedSeq: 11,
      attemptsUsed: 1,
    });
    expectLevel(state.book.bids, 10000, 100);
    expectLevel(state.book.asks, 10005, 100);
  });

  it("rejects a range that adds a crossing bid without explicitly removing crossed asks", () => {
    const sync = new BookSync();
    const initialAsks = asks(
      [10005, 100],
      [10006, 100],
      [11000, 100],
      [11001, 100],
      [11002, 100],
      [11003, 100],
      [11004, 100],
      [11005, 100],
      [11006, 100],
      [11007, 100],
      [11008, 100],
      [11009, 100],
      [11010, 100],
      [11011, 100],
      [11012, 100],
      [11013, 100],
      [11014, 100],
      [11015, 100],
      [11016, 100],
      [11017, 100],
    );

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 10, bids([10000, 100]), initialAsks), 1, 10);

    const effects = sync.receiveRange(
      {
        session: "s1",
        from: 11,
        to: 12,
        bids: bids([10006, 200]),
        asks: asks([10008, 300]),
      },
      20,
    );

    expect(effects).toEqual({ fetchSnapshot: { generation: 2, delayMs: 0 } });
    const state = sync.getState();
    expect(state).toMatchObject({
      status: "buffering",
      generation: 2,
      expectedSeq: 11,
      attemptsUsed: 1,
    });
    expectLevel(state.book.bids, 10000, 100);
    expect(state.book.asks).toHaveLength(20);
    expect(state.book.asks).toEqual(initialAsks);
    expectLevel(state.book.asks, 10005, 100);
    expectLevel(state.book.asks, 10006, 100);
    expect(state.book.bids.find((level) => level.priceTicks === 10006)).toBeUndefined();
  });

  it("rejects an empty changed range and spends the shared retry budget", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 10, bids([10000, 100]), asks([10005, 100])), 1, 10);

    const effects = sync.receiveRange({ session: "s1", from: 11, to: 11, bids: [], asks: [] }, 20);

    expect(effects).toEqual({ fetchSnapshot: { generation: 2, delayMs: 0 } });
    expect(sync.getState()).toMatchObject({
      status: "buffering",
      generation: 2,
      expectedSeq: 11,
      attemptsUsed: 1,
    });
  });

  it("uses the same retry episode after a malformed range and a failed replacement fetch", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 10, bids([10000, 100]), asks([10005, 100])), 1, 10);

    expect(sync.receiveRange({ session: "s1", from: 12, to: 11, bids: bids([9999, 100]), asks: [] }, 20)).toEqual({
      fetchSnapshot: { generation: 2, delayMs: 0 },
    });
    expect(sync.failed(2, 30)).toEqual({ fetchSnapshot: { generation: 3, delayMs: 500 } });
    expect(sync.getState()).toMatchObject({
      status: "buffering",
      generation: 3,
      expectedSeq: 11,
      attemptsUsed: 2,
    });
  });

  it("ignores a range from the wrong session without changing the active session", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 10, bids([10000, 100]), asks([10001, 100])), 1, 10);

    const effects = sync.receiveRange({ session: "s2", from: 11, to: 12, bids: bids([9999, 200]), asks: [] }, 20);

    expect(effects).toEqual({});
    const state = sync.getState();
    expect(state).toMatchObject({
      session: "s1",
      status: "synced",
      generation: 1,
      expectedSeq: 11,
      bufferedRanges: 0,
    });
    expectValidDepth(state.book);
    expectLevel(state.book.bids, 10000, 100);
    expectLevel(state.book.asks, 10001, 100);
  });

  it("starts a new session only when an accepted hello calls start", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 10, bids([10000, 100]), asks([10001, 100])), 1, 10);

    const effects = sync.start("s2", 20);

    expect(effects).toEqual({ fetchSnapshot: { generation: 1, delayMs: 0 } });
    expect(sync.getState()).toMatchObject({
      session: "s2",
      status: "buffering",
      generation: 1,
      expectedSeq: null,
      bufferedRanges: 0,
      book: { bids: [], asks: [] },
    });
  });

  it("ignores stale ranges and snapshots from a previous session after start", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.receiveRange({ session: "s1", from: 10, to: 10, bids: bids([10000, 100]), asks: [] }, 5);
    sync.start("s2", 10);
    sync.receiveRange({ session: "s1", from: 11, to: 11, bids: bids([9999, 200]), asks: [] }, 15);
    sync.receiveSnapshot(snapshot("s1", 11, bids([9999, 200]), asks([10001, 100])), 1, 20);

    expect(sync.getState()).toMatchObject({
      session: "s2",
      status: "buffering",
      generation: 1,
      expectedSeq: null,
      bufferedRanges: 0,
      book: { bids: [], asks: [] },
    });
  });

  it("spends a shared episode attempt when the buffered bytes limit overflows", () => {
    const sync = new BookSync({ maxBufferedBytes: 1 });

    sync.start("s1", 0);
    const effects = sync.receiveRange({ session: "s1", from: 10, to: 10, bids: bids([10000, 100]), asks: [] }, 10);

    expect(effects).toEqual({ fetchSnapshot: { generation: 2, delayMs: 500 } });
    expect(sync.getState()).toMatchObject({
      status: "buffering",
      generation: 2,
      attemptsUsed: 2,
      bufferedRanges: 0,
      bufferedBytes: 0,
    });
  });

  it("accepts buffered ranges when explicit wire bytes exactly meet the cap", () => {
    const sync = new BookSync({ maxBufferedBytes: 1000 });

    sync.start("s1", 0);
    expect(sync.receiveRange({ session: "s1", from: 10, to: 10, bids: bids([10000, 100]), asks: [] }, 10, 400)).toEqual(
      {},
    );
    expect(sync.receiveRange({ session: "s1", from: 11, to: 11, bids: bids([9999, 100]), asks: [] }, 20, 600)).toEqual(
      {},
    );

    expect(sync.getState()).toMatchObject({
      status: "buffering",
      generation: 1,
      attemptsUsed: 1,
      bufferedRanges: 2,
      bufferedBytes: 1000,
    });
  });

  it("overflows when explicit wire bytes exceed the cap by one and spends the shared budget", () => {
    const sync = new BookSync({ maxBufferedBytes: 1000 });

    sync.start("s1", 0);
    sync.receiveRange({ session: "s1", from: 10, to: 10, bids: bids([10000, 100]), asks: [] }, 10, 400);
    const effects = sync.receiveRange(
      { session: "s1", from: 11, to: 11, bids: bids([9999, 100]), asks: [] },
      20,
      601,
    );

    expect(effects).toEqual({ fetchSnapshot: { generation: 2, delayMs: 500 } });
    expect(sync.getState()).toMatchObject({
      status: "buffering",
      generation: 2,
      attemptsUsed: 2,
      bufferedRanges: 0,
      bufferedBytes: 0,
    });
  });

  it("does not charge explicit wire bytes for wrong-session or stale ranges", () => {
    const sync = new BookSync({ maxBufferedBytes: 1000 });

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 20, bids([10000, 100]), asks([10001, 100])), 1, 5);
    expect(sync.receiveRange({ session: "s2", from: 21, to: 21, bids: bids([9999, 100]), asks: [] }, 10, 900)).toEqual(
      {},
    );
    expect(sync.receiveRange({ session: "s1", from: 10, to: 20, bids: bids([9998, 100]), asks: [] }, 20, 900)).toEqual(
      {},
    );

    expect(sync.getState()).toMatchObject({
      session: "s1",
      status: "synced",
      generation: 1,
      expectedSeq: 21,
      bufferedRanges: 0,
      bufferedBytes: 0,
      attemptsUsed: 0,
    });
  });

  it("clears explicit buffered wire bytes after a snapshot replay succeeds", () => {
    const sync = new BookSync({ maxBufferedBytes: 1000 });

    sync.start("s1", 0);
    sync.receiveRange({ session: "s1", from: 10, to: 10, bids: bids([10000, 100]), asks: [] }, 10, 400);
    sync.receiveRange({ session: "s1", from: 11, to: 11, bids: bids([9999, 100]), asks: [] }, 20, 500);

    const effects = sync.receiveSnapshot(snapshot("s1", 9, bids([9998, 100]), asks([10001, 100])), 1, 30);

    expect(effects).toEqual({});
    expect(sync.getState()).toMatchObject({
      status: "synced",
      generation: 1,
      expectedSeq: 12,
      bufferedRanges: 0,
      bufferedBytes: 0,
      attemptsUsed: 0,
    });
  });

  it("uses recover for book reset without starting a fresh attempt budget", () => {
    const sync = new BookSync();

    sync.start("s1", 0);

    expect(sync.recover(10)).toEqual({ fetchSnapshot: { generation: 2, delayMs: 500 } });
    expect(sync.recover(20)).toEqual({ fetchSnapshot: { generation: 3, delayMs: 1000 } });
    expect(sync.failed(3, 30)).toEqual({ fetchSnapshot: { generation: 4, delayMs: 2000 } });
    expect(sync.recover(40)).toEqual({ fetchSnapshot: { generation: 5, delayMs: 4000 } });
    expect(sync.recover(50)).toEqual({});

    expect(sync.getState()).toMatchObject({
      session: "s1",
      status: "failed",
      generation: 5,
      attemptsUsed: 5,
    });
  });

  it("starts a fresh same-session attempt budget with monotonic generation after manual retry", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.recover(10);
    sync.recover(20);
    sync.failed(3, 30);
    sync.recover(40);
    sync.recover(50);

    const effects = sync.start("s1", 60);

    expect(effects).toEqual({ fetchSnapshot: { generation: 6, delayMs: 0 } });
    expect(sync.getState()).toMatchObject({
      session: "s1",
      status: "buffering",
      generation: 6,
      attemptsUsed: 1,
      bufferedRanges: 0,
      bufferedBytes: 0,
      book: { bids: [], asks: [] },
    });
  });

  it("rejects a late snapshot from before a same-session manual retry", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.recover(10);
    sync.recover(20);
    sync.failed(3, 30);
    sync.recover(40);
    sync.recover(50);
    sync.start("s1", 60);

    const effects = sync.receiveSnapshot(snapshot("s1", 30, bids([10000, 100]), asks([10001, 100])), 5, 70);

    expect(effects).toEqual({});
    expect(sync.getState()).toMatchObject({
      session: "s1",
      status: "buffering",
      generation: 6,
      expectedSeq: null,
      book: { bids: [], asks: [] },
    });
  });

  it("accepts the current snapshot after rejecting a late manual retry response", () => {
    const sync = new BookSync();

    sync.start("s1", 0);
    sync.recover(10);
    sync.recover(20);
    sync.failed(3, 30);
    sync.recover(40);
    sync.recover(50);
    sync.start("s1", 60);
    sync.receiveSnapshot(snapshot("s1", 30, bids([9999, 999]), asks([10002, 999])), 5, 70);

    const effects = sync.receiveSnapshot(snapshot("s1", 40, bids([10000, 100]), asks([10001, 100])), 6, 80);

    expect(effects).toEqual({});
    const state = sync.getState();
    expect(state).toMatchObject({
      session: "s1",
      status: "synced",
      generation: 6,
      expectedSeq: 41,
      attemptsUsed: 0,
    });
    expectValidDepth(state.book);
    expectLevel(state.book.bids, 10000, 100);
    expectLevel(state.book.asks, 10001, 100);
  });

  it("spends one shared five-attempt budget across gaps overflows and failed fetches", () => {
    const sync = new BookSync({ maxBufferedRanges: 1 });

    sync.start("s1", 0);
    sync.receiveSnapshot(snapshot("s1", 10, bids([10000, 100]), asks([10001, 100])), 1, 1);

    expect(sync.receiveRange({ session: "s1", from: 12, to: 12, bids: bids([9999, 200]), asks: [] }, 10)).toEqual({
      fetchSnapshot: { generation: 2, delayMs: 0 },
    });
    expect(sync.receiveRange({ session: "s1", from: 13, to: 13, bids: bids([9998, 200]), asks: [] }, 20)).toEqual({});
    expect(sync.receiveRange({ session: "s1", from: 14, to: 14, bids: bids([9997, 200]), asks: [] }, 30)).toEqual({
      fetchSnapshot: { generation: 3, delayMs: 500 },
    });
    expect(sync.failed(3, 40)).toEqual({ fetchSnapshot: { generation: 4, delayMs: 1000 } });
    expect(sync.failed(4, 50)).toEqual({ fetchSnapshot: { generation: 5, delayMs: 2000 } });
    expect(sync.failed(5, 60)).toEqual({ fetchSnapshot: { generation: 6, delayMs: 4000 } });
    expect(sync.failed(6, 70)).toEqual({});

    expect(sync.getState()).toMatchObject({
      status: "failed",
      generation: 6,
      attemptsUsed: 5,
    });
  });
});
