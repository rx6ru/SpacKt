import type { Candle, Interval } from "../domain/model";

export type CandleFeedEffects = {
  fetchHistory?: { interval: Interval; requestId: number; generation: number };
  resync?: { interval: Interval; requestId: number; reason: "equal_rev_conflict" };
};

export type CandleFeedState = {
  session: string | null;
  interval: Interval | null;
  requestId: number | null;
  generation: number;
  status: "idle" | "loading" | "ready" | "invalid";
  candles: Candle[];
};

export type CandleHistory = {
  session: string;
  interval: Interval;
  requestId: number;
  candles: Candle[];
};

export type CandleLiveBatch = {
  session: string;
  interval: Interval;
  requestId: number;
  items: Candle[];
};

const MAX_CANDLES = 1000;

const cloneCandle = (candle: Candle): Candle => ({ ...candle });

const candlesEqual = (left: Candle, right: Candle): boolean =>
  left.timeMs === right.timeMs &&
  left.openTicks === right.openTicks &&
  left.highTicks === right.highTicks &&
  left.lowTicks === right.lowTicks &&
  left.closeTicks === right.closeTicks &&
  left.volumeLots === right.volumeLots &&
  left.rev === right.rev &&
  left.closed === right.closed;

export class CandleFeed {
  private session: string | null = null;
  private interval: Interval | null = null;
  private requestId: number | null = null;
  private generation = 0;
  private status: CandleFeedState["status"] = "idle";
  private candlesByTime = new Map<number, Candle>();

  reset(session: string): CandleFeedEffects {
    this.session = session;
    this.interval = null;
    this.requestId = null;
    this.generation += 1;
    this.status = "idle";
    this.candlesByTime.clear();
    return {};
  }

  select(interval: Interval, requestId: number): CandleFeedEffects {
    this.interval = interval;
    this.requestId = requestId;
    this.generation += 1;
    this.status = "loading";
    this.candlesByTime.clear();
    return { fetchHistory: { interval, requestId, generation: this.generation } };
  }

  receiveHistory(payload: CandleHistory, generation: number): CandleFeedEffects {
    if (!this.accepts(payload.session, payload.interval, payload.requestId) || generation !== this.generation) {
      return {};
    }

    const next = new Map(this.candlesByTime);
    const effects = this.mergeInto(next, payload.candles);
    if (effects.resync) {
      this.status = "invalid";
      return effects;
    }

    this.candlesByTime = next;
    this.trimCandles();
    if (this.status !== "invalid") {
      this.status = "ready";
    }

    return {};
  }

  receiveLive(payload: CandleLiveBatch): CandleFeedEffects {
    if (!this.accepts(payload.session, payload.interval, payload.requestId)) {
      return {};
    }

    const next = new Map(this.candlesByTime);
    const effects = this.mergeInto(next, payload.items);
    if (effects.resync) {
      this.status = "invalid";
      return effects;
    }

    this.candlesByTime = next;
    this.trimCandles();
    if (this.status === "loading") {
      this.status = "ready";
    }

    return {};
  }

  getState(): CandleFeedState {
    return {
      session: this.session,
      interval: this.interval,
      requestId: this.requestId,
      generation: this.generation,
      status: this.status,
      candles: this.sortedCandles(),
    };
  }

  private accepts(session: string, interval: Interval, requestId: number): boolean {
    return this.session === session && this.interval === interval && this.requestId === requestId;
  }

  private mergeInto(target: Map<number, Candle>, incoming: Candle[]): CandleFeedEffects {
    for (const item of incoming) {
      const current = target.get(item.timeMs);
      if (!current || item.rev > current.rev) {
        target.set(item.timeMs, cloneCandle(item));
        continue;
      }

      if (item.rev === current.rev && !candlesEqual(item, current)) {
        return this.resyncEffect();
      }
    }

    return {};
  }

  private resyncEffect(): CandleFeedEffects {
    if (this.interval === null || this.requestId === null) {
      return {};
    }

    return { resync: { interval: this.interval, requestId: this.requestId, reason: "equal_rev_conflict" } };
  }

  private sortedCandles(): Candle[] {
    return Array.from(this.candlesByTime.values())
      .sort((left, right) => left.timeMs - right.timeMs)
      .map(cloneCandle);
  }

  private trimCandles(): void {
    if (this.candlesByTime.size <= MAX_CANDLES) {
      return;
    }

    const timesToDrop = Array.from(this.candlesByTime.keys())
      .sort((left, right) => left - right)
      .slice(0, this.candlesByTime.size - MAX_CANDLES);
    for (const timeMs of timesToDrop) {
      this.candlesByTime.delete(timeMs);
    }
  }
}
