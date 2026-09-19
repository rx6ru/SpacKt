export type ObservedRateState = {
  valuePerSecond: number | null;
  windowMs: number;
  sampleCount: number;
};

export class ObservedRate {
  private events: number[] = [];
  constructor(private startedAt: number) {}

  reset(now: number): void {
    this.startedAt = now;
    this.events = [];
  }

  record(now: number): void {
    this.prune(now);
    this.events.push(now);
  }

  read(now: number): ObservedRateState {
    this.prune(now);
    const windowMs = Math.min(now - this.startedAt, 10_000);
    return {
      valuePerSecond: windowMs < 1_000 ? null : this.events.length / (windowMs / 1_000),
      windowMs,
      sampleCount: this.events.length,
    };
  }

  private prune(now: number): void {
    this.events = this.events.filter((time) => time > now - 10_000);
  }
}
