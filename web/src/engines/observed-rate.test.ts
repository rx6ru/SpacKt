import { describe, expect, it } from "vitest";
import { ObservedRate } from "./observed-rate";

describe("ObservedRate", () => {
  it("returns a null rate before one second of observation", () => {
    const rate = new ObservedRate(1_000);

    rate.record(1_250);

    expect(rate.read(1_999)).toEqual({
      valuePerSecond: null,
      windowMs: 999,
      sampleCount: 1,
    });
  });

  it("uses elapsed observation time as the denominator before ten seconds", () => {
    const rate = new ObservedRate(0);

    rate.record(1_000);
    rate.record(3_000);

    expect(rate.read(4_000)).toEqual({
      valuePerSecond: 0.5,
      windowMs: 4_000,
      sampleCount: 2,
    });
    expect(rate.read(8_000)).toEqual({
      valuePerSecond: 0.25,
      windowMs: 8_000,
      sampleCount: 2,
    });
  });

  it("caps the denominator at ten seconds after the observation window matures", () => {
    const rate = new ObservedRate(0);

    rate.record(6_001);
    rate.record(12_000);
    rate.record(15_000);

    expect(rate.read(16_000)).toEqual({
      valuePerSecond: 0.3,
      windowMs: 10_000,
      sampleCount: 3,
    });
  });

  it("expires samples on read using the half-open ten-second rolling interval", () => {
    const rate = new ObservedRate(0);

    rate.record(1);
    rate.record(10_000);

    expect(rate.read(10_000)).toEqual({
      valuePerSecond: 0.2,
      windowMs: 10_000,
      sampleCount: 2,
    });
    expect(rate.read(10_001)).toEqual({
      valuePerSecond: 0.1,
      windowMs: 10_000,
      sampleCount: 1,
    });
    expect(rate.read(20_000)).toEqual({
      valuePerSecond: 0,
      windowMs: 10_000,
      sampleCount: 0,
    });
  });

  it("counts multiple accepted messages at the same timestamp separately", () => {
    const rate = new ObservedRate(0);

    rate.record(2_500);
    rate.record(2_500);
    rate.record(2_500);

    expect(rate.read(5_000)).toEqual({
      valuePerSecond: 0.6,
      windowMs: 5_000,
      sampleCount: 3,
    });
  });

  it("returns zero after one quiet second with no messages", () => {
    const rate = new ObservedRate(10);

    expect(rate.read(1_010)).toEqual({
      valuePerSecond: 0,
      windowMs: 1_000,
      sampleCount: 0,
    });
  });

  it("reset clears events and starts a fresh observation window", () => {
    const rate = new ObservedRate(0);

    rate.record(1_000);
    rate.record(2_000);
    rate.reset(5_000);
    rate.record(5_500);

    expect(rate.read(5_999)).toEqual({
      valuePerSecond: null,
      windowMs: 999,
      sampleCount: 1,
    });
    expect(rate.read(6_000)).toEqual({
      valuePerSecond: 1,
      windowMs: 1_000,
      sampleCount: 1,
    });
  });

  it("returns copied results that cannot mutate later reads", () => {
    const rate = new ObservedRate(0);

    rate.record(1_000);
    const first = rate.read(2_000);
    first.valuePerSecond = 99;
    first.windowMs = 99;
    first.sampleCount = 99;

    expect(rate.read(2_000)).toEqual({
      valuePerSecond: 0.5,
      windowMs: 2_000,
      sampleCount: 1,
    });
  });
});
