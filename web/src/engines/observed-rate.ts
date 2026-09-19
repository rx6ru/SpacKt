export type ObservedRateState = {
  valuePerSecond: number | null;
  windowMs: number;
  sampleCount: number;
};

export class ObservedRate {
  constructor(now: number) { void now; }
  reset(now: number): void {
    void now;
    throw new Error("Not implemented: ObservedRate.reset");
  }
  record(now: number): void {
    void now;
    throw new Error("Not implemented: ObservedRate.record");
  }
  read(now: number): ObservedRateState {
    void now;
    throw new Error("Not implemented: ObservedRate.read");
  }
}
