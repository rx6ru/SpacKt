export type TelemetryEffects = {
  ping?: { id: number };
  timedOut?: number[];
};

export type TelemetryReport = {
  latencyMs: number;
  jitterMs: number;
  samples: number;
};

export type TelemetryState = {
  epoch: number;
  unresolved: number;
  successes: SuccessSample[];
  timedOutIds: number[];
};

type SuccessSample = {
  id: number;
  sentAtMs: number;
  receivedAtMs: number;
  rttMs: number;
};

type PendingPing = {
  id: number;
  sentAtMs: number;
};

const MAX_IN_FLIGHT = 4;
const MAX_SUCCESSES = 10;
const MAX_TIMED_OUT_IDS = 100;
const SAMPLE_MAX_AGE_MS = 10_000;
const TIMEOUT_MS = 3_000;

export class Telemetry {
  private epoch = 0;
  private pending = new Map<number, PendingPing>();
  private successes: SuccessSample[] = [];
  private timedOutIds: number[] = [];
  private highWaterId = 0;

  reset(epoch?: number): TelemetryEffects {
    if (epoch !== undefined && epoch !== this.epoch) {
      this.epoch = epoch;
      this.highWaterId = 0;
    }

    this.pending.clear();
    this.successes = [];
    this.timedOutIds = [];
    return {};
  }

  pingSent(id: number, now: number, epoch = this.epoch): TelemetryEffects {
    if (!this.canSend(id, epoch)) {
      return {};
    }

    this.pending.set(id, { id, sentAtMs: now });
    this.highWaterId = id;
    return { ping: { id } };
  }

  pongReceived(id: number, now: number, epoch = this.epoch): TelemetryEffects {
    if (epoch !== this.epoch) {
      return {};
    }

    const pending = this.pending.get(id);
    if (!pending) {
      return {};
    }

    this.pending.delete(id);
    if (now - pending.sentAtMs >= TIMEOUT_MS) {
      this.recordTimeout(id);
      return {};
    }

    this.successes.push({
      id,
      sentAtMs: pending.sentAtMs,
      receivedAtMs: now,
      rttMs: now - pending.sentAtMs,
    });
    this.trimSuccesses(now);
    return {};
  }

  advance(now: number): TelemetryEffects {
    const timedOut: number[] = [];

    for (const pending of this.pending.values()) {
      if (now - pending.sentAtMs >= TIMEOUT_MS) {
        timedOut.push(pending.id);
      }
    }

    for (const id of timedOut) {
      this.pending.delete(id);
      this.recordTimeout(id);
    }

    this.trimSuccesses(now);
    return timedOut.length > 0 ? { timedOut } : {};
  }

  report(now: number): TelemetryReport | null {
    this.trimSuccesses(now);
    if (this.successes.length < 2) {
      return null;
    }

    const rtts = this.successes.map((sample) => sample.rttMs).sort((left, right) => left - right);
    const middle = Math.floor(rtts.length / 2);
    const latencyMs = rtts.length % 2 === 1 ? rtts[middle]! : (rtts[middle - 1]! + rtts[middle]!) / 2;

    return {
      latencyMs,
      jitterMs: this.jitter(),
      samples: this.successes.length,
    };
  }

  getState(): TelemetryState {
    return {
      epoch: this.epoch,
      unresolved: this.pending.size,
      successes: this.successes.map(cloneSuccess),
      timedOutIds: [...this.timedOutIds],
    };
  }

  private canSend(id: number, epoch: number): boolean {
    return (
      epoch === this.epoch &&
      Number.isSafeInteger(id) &&
      id > this.highWaterId &&
      this.pending.size < MAX_IN_FLIGHT
    );
  }

  private recordTimeout(id: number): void {
    this.timedOutIds.push(id);
    this.trimTimedOutIds();
  }

  private trimSuccesses(now: number): void {
    this.successes = this.successes
      .filter((sample) => now - sample.sentAtMs <= SAMPLE_MAX_AGE_MS)
      .sort((left, right) => left.sentAtMs - right.sentAtMs)
      .slice(-MAX_SUCCESSES);
  }

  private trimTimedOutIds(): void {
    if (this.timedOutIds.length > MAX_TIMED_OUT_IDS) {
      this.timedOutIds = this.timedOutIds.slice(-MAX_TIMED_OUT_IDS);
    }
  }

  private jitter(): number {
    let total = 0;

    for (let index = 1; index < this.successes.length; index += 1) {
      total += Math.abs(this.successes[index]!.rttMs - this.successes[index - 1]!.rttMs);
    }

    return total / (this.successes.length - 1);
  }
}

const cloneSuccess = (sample: SuccessSample): SuccessSample => ({ ...sample });
