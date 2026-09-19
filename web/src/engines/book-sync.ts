import type { Level } from "../domain/model";

export type BookSide = { bids: Level[]; asks: Level[] };
export type BookSnapshot = BookSide & { session: string; seq: number };
export type BookRange = BookSide & { session: string; from: number; to: number };
export type BookSyncEffects = { fetchSnapshot?: { generation: number; delayMs: number } };
export type BookSyncState = {
  session: string | null;
  status: "idle" | "buffering" | "synced" | "failed";
  generation: number;
  expectedSeq: number | null;
  attemptsUsed: number;
  bufferedRanges: number;
  bufferedBytes: number;
  book: BookSide;
};

type Options = {
  maxBufferedRanges?: number;
  maxBufferedBytes?: number;
  maxAttempts?: number;
  retryDelaysMs?: number[];
};

type BufferedRange = {
  range: BookRange;
  bytes: number;
};

const DEFAULT_RETRY_DELAYS_MS = [0, 500, 1000, 2000, 4000] as const;
const DEFAULT_MAX_BUFFERED_RANGES = 500;
const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 5;

export class BookSync {
  private readonly maxBufferedRanges: number;
  private readonly maxBufferedBytes: number;
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: number[];

  private session: string | null = null;
  private status: BookSyncState["status"] = "idle";
  private generation = 0;
  private expectedSeq: number | null = null;
  private attemptsUsed = 0;
  private buffered: BufferedRange[] = [];
  private bufferedBytes = 0;
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();

  constructor(options: Options = {}) {
    this.maxBufferedRanges = positiveOption(options.maxBufferedRanges, DEFAULT_MAX_BUFFERED_RANGES);
    this.maxBufferedBytes = positiveOption(options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES);
    this.maxAttempts = positiveOption(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.retryDelaysMs = options.retryDelaysMs?.length ? [...options.retryDelaysMs] : [...DEFAULT_RETRY_DELAYS_MS];
  }

  start(session: string, now: number): BookSyncEffects {
    void now;
    const sameSession = this.session === session;

    this.session = session;
    this.status = "buffering";
    this.generation = sameSession ? this.generation + 1 : 1;
    this.expectedSeq = null;
    this.attemptsUsed = 1;
    this.clearBuffer();
    this.clearBook();

    return { fetchSnapshot: { generation: this.generation, delayMs: this.delayForAttempt(0) } };
  }

  recover(now: number): BookSyncEffects {
    void now;
    return this.requestSnapshot();
  }

  receiveSnapshot(snapshot: BookSnapshot, generation: number, now: number): BookSyncEffects {
    void now;
    if (snapshot.session !== this.session || generation !== this.generation || this.status !== "buffering") {
      return {};
    }

    if (!isNonNegativeSafeInteger(snapshot.seq) || !isValidSnapshotSide(snapshot.bids, "bids") || !isValidSnapshotSide(snapshot.asks, "asks")) {
      return this.requestSnapshot();
    }

    const nextBids = levelsToMap(snapshot.bids);
    const nextAsks = levelsToMap(snapshot.asks);
    if (!isValidBook(nextBids, nextAsks)) {
      return this.requestSnapshot();
    }

    let nextExpected = snapshot.seq + 1;
    for (const buffered of this.buffered) {
      const range = buffered.range;
      if (range.to < nextExpected) {
        continue;
      }

      if (range.from > nextExpected) {
        return this.requestSnapshot();
      }

      const applied = applyRange(nextBids, nextAsks, range);
      if (!applied.ok) {
        return this.requestSnapshot();
      }

      nextExpected = range.to + 1;
    }

    this.bids = nextBids;
    this.asks = nextAsks;
    this.expectedSeq = nextExpected;
    this.status = "synced";
    this.attemptsUsed = 0;
    this.clearBuffer();

    return {};
  }

  receiveRange(range: BookRange, now: number, wireBytes?: number): BookSyncEffects {
    void now;
    if (range.session !== this.session) {
      return {};
    }

    if (!isValidRange(range)) {
      return this.requestSnapshot();
    }

    if (this.status === "synced") {
      if (this.expectedSeq === null) {
        return this.requestSnapshot();
      }

      if (range.to < this.expectedSeq) {
        return {};
      }

      if (range.from > this.expectedSeq) {
        return this.requestSnapshot();
      }

      const nextBids = new Map(this.bids);
      const nextAsks = new Map(this.asks);
      const applied = applyRange(nextBids, nextAsks, range);
      if (!applied.ok) {
        return this.requestSnapshot();
      }

      this.bids = nextBids;
      this.asks = nextAsks;
      this.expectedSeq = range.to + 1;
      return {};
    }

    if (this.status !== "buffering") {
      return {};
    }

    const bytes = bufferedRangeBytes(range, wireBytes);
    if (this.buffered.length + 1 > this.maxBufferedRanges || this.bufferedBytes + bytes > this.maxBufferedBytes) {
      return this.requestSnapshot();
    }

    this.buffered.push({ range: cloneRange(range), bytes });
    this.bufferedBytes += bytes;
    return {};
  }

  failed(generation: number, now: number): BookSyncEffects {
    void now;
    if (generation !== this.generation || this.status !== "buffering") {
      return {};
    }

    return this.requestSnapshot();
  }

  getState(): BookSyncState {
    return {
      session: this.session,
      status: this.status,
      generation: this.generation,
      expectedSeq: this.expectedSeq,
      attemptsUsed: this.attemptsUsed,
      bufferedRanges: this.buffered.length,
      bufferedBytes: this.bufferedBytes,
      book: {
        bids: sortedLevels(this.bids, "bids"),
        asks: sortedLevels(this.asks, "asks"),
      },
    };
  }

  private requestSnapshot(): BookSyncEffects {
    if (this.session === null || this.attemptsUsed >= this.maxAttempts) {
      this.status = "failed";
      this.clearBuffer();
      return {};
    }

    const delayMs = this.delayForAttempt(this.attemptsUsed);
    this.attemptsUsed += 1;
    this.generation += 1;
    this.status = "buffering";
    this.clearBuffer();

    return { fetchSnapshot: { generation: this.generation, delayMs } };
  }

  private delayForAttempt(index: number): number {
    return this.retryDelaysMs[index] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1] ?? 0;
  }

  private clearBuffer(): void {
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  private clearBook(): void {
    this.bids = new Map();
    this.asks = new Map();
  }
}

const positiveOption = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;

const isNonNegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const isValidLevel = (level: Level, allowZero: boolean): boolean =>
  Number.isSafeInteger(level.priceTicks) &&
  level.priceTicks > 0 &&
  Number.isSafeInteger(level.quantityLots) &&
  (allowZero ? level.quantityLots >= 0 : level.quantityLots > 0);

const isValidSnapshotSide = (levels: Level[], side: "bids" | "asks"): boolean => {
  if (levels.length < 10 || levels.length > 50) {
    return false;
  }

  return isSortedUnique(levels, side) && levels.every((level) => isValidLevel(level, false));
};

const isValidRangeSide = (levels: Level[]): boolean => isUnique(levels) && levels.every((level) => isValidLevel(level, true));

const isValidRange = (range: BookRange): boolean =>
  isPositiveSafeInteger(range.from) &&
  isPositiveSafeInteger(range.to) &&
  range.from <= range.to &&
  range.bids.length + range.asks.length >= 1 &&
  range.bids.length + range.asks.length <= 4096 &&
  isValidRangeSide(range.bids) &&
  isValidRangeSide(range.asks);

const isSortedUnique = (levels: Level[], side: "bids" | "asks"): boolean => {
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1];
    const current = levels[index];
    if (previous === undefined || current === undefined) {
      return false;
    }

    if (side === "bids" ? previous.priceTicks <= current.priceTicks : previous.priceTicks >= current.priceTicks) {
      return false;
    }
  }

  return true;
};

const isUnique = (levels: Level[]): boolean => {
  const seen = new Set<number>();

  for (const level of levels) {
    if (seen.has(level.priceTicks)) {
      return false;
    }

    seen.add(level.priceTicks);
  }

  return true;
};

const levelsToMap = (levels: Level[]): Map<number, number> => new Map(levels.map((level) => [level.priceTicks, level.quantityLots]));

const applyRange = (bids: Map<number, number>, asks: Map<number, number>, range: BookRange): { ok: boolean } => {
  for (const level of range.bids) {
    applyLevel(bids, level);
  }

  for (const level of range.asks) {
    applyLevel(asks, level);
  }

  return { ok: isValidBook(bids, asks) };
};

const applyLevel = (levels: Map<number, number>, level: Level): void => {
  if (level.quantityLots === 0) {
    levels.delete(level.priceTicks);
    return;
  }

  levels.set(level.priceTicks, level.quantityLots);
};

const isValidBook = (bids: Map<number, number>, asks: Map<number, number>): boolean => {
  if (bids.size < 10 || bids.size > 50 || asks.size < 10 || asks.size > 50) {
    return false;
  }

  const bestBid = Math.max(...bids.keys());
  const bestAsk = Math.min(...asks.keys());
  return bestBid < bestAsk && allPositiveIntegerEntries(bids) && allPositiveIntegerEntries(asks);
};

const allPositiveIntegerEntries = (levels: Map<number, number>): boolean => {
  for (const [priceTicks, quantityLots] of levels) {
    if (!Number.isSafeInteger(priceTicks) || priceTicks <= 0 || !Number.isSafeInteger(quantityLots) || quantityLots <= 0) {
      return false;
    }
  }

  return true;
};

const sortedLevels = (levels: Map<number, number>, side: "bids" | "asks"): Level[] =>
  Array.from(levels, ([priceTicks, quantityLots]) => ({ priceTicks, quantityLots })).sort((left, right) =>
    side === "bids" ? right.priceTicks - left.priceTicks : left.priceTicks - right.priceTicks,
  );

const cloneLevels = (levels: Level[]): Level[] => levels.map((level) => ({ priceTicks: level.priceTicks, quantityLots: level.quantityLots }));

const cloneRange = (range: BookRange): BookRange => ({
  session: range.session,
  from: range.from,
  to: range.to,
  bids: cloneLevels(range.bids),
  asks: cloneLevels(range.asks),
});

const bufferedRangeBytes = (range: BookRange, wireBytes: number | undefined): number => {
  if (typeof wireBytes === "number" && isPositiveSafeInteger(wireBytes)) {
    return wireBytes;
  }

  return estimateBufferedRangeBytes(range);
};

const estimateBufferedRangeBytes = (range: BookRange): number => {
  let bytes = 38 + range.session.length + digits(range.from) + digits(range.to);

  for (const level of range.bids) {
    bytes += estimateLevelBytes(level);
  }

  for (const level of range.asks) {
    bytes += estimateLevelBytes(level);
  }

  return bytes;
};

const estimateLevelBytes = (level: Level): number => 8 + digits(level.priceTicks) + digits(level.quantityLots);

const digits = (value: number): number => String(value).length;
