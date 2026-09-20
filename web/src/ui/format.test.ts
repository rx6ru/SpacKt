import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatCandle, formatStatusTime } from "./format";

const originalTZ = process.env.TZ;
const indiaOffset = /GMT\+0?5:?30/;
const newYorkDst = /(?:EDT|GMT-0?4(?::?00)?)/;

function restoreTZ() {
  if (originalTZ === undefined) {
    delete process.env.TZ;
    return;
  }
  process.env.TZ = originalTZ;
}

beforeEach(() => {
  restoreTZ();
});

afterEach(() => {
  restoreTZ();
});

describe("time formatters", () => {
  it("formats status times in the viewer local offset", () => {
    process.env.TZ = "Asia/Kolkata";

    expect(formatStatusTime(Date.parse("2024-01-01T23:30:00Z"))).toMatch(new RegExp(`^05:00:00 ${indiaOffset.source}$`));
  });

  it("formats candle times with daylight-saving rollover in the viewer local zone", () => {
    process.env.TZ = "America/New_York";

    expect(formatCandle({
      timeMs: Date.parse("2024-03-10T07:30:00Z"),
      openTicks: 10_000,
      highTicks: 10_250,
      lowTicks: 9_975,
      closeTicks: 10_125,
      volumeLots: 12_345,
      rev: 1,
      closed: false,
    }, null)).toMatch(new RegExp(`03:30:00 ${newYorkDst.source}`));
  });
});
