import { describe, expect, it } from "vitest";
import { Telemetry } from "./telemetry";

describe("Telemetry", () => {
  it("reset with an explicit epoch clears pending probes samples timeouts and reports", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pingSent(2, 100);
    telemetry.pongReceived(2, 250);
    telemetry.advance(3001);
    telemetry.reset(8);

    expect(telemetry.getState()).toEqual({
      epoch: 8,
      unresolved: 0,
      successes: [],
      timedOutIds: [],
    });
    expect(telemetry.report(4000)).toBeNull();
  });

  it("reset without an epoch keeps the current epoch", () => {
    const telemetry = new Telemetry();

    telemetry.reset(4);
    telemetry.pingSent(1, 1000);
    telemetry.reset();

    expect(telemetry.getState()).toMatchObject({
      epoch: 4,
      unresolved: 0,
      successes: [],
      timedOutIds: [],
    });
  });

  it("ignores a pong from the epoch before reset", () => {
    const telemetry = new Telemetry();

    telemetry.reset(3);
    telemetry.pingSent(11, 1000);
    telemetry.reset(4);
    telemetry.pongReceived(11, 1100, 3);

    expect(telemetry.getState()).toMatchObject({
      epoch: 4,
      unresolved: 0,
      successes: [],
    });
  });

  it("computes median latency from successful RTT samples", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pongReceived(1, 100);
    telemetry.pingSent(2, 100);
    telemetry.pongReceived(2, 220);
    telemetry.pingSent(3, 220);
    telemetry.pongReceived(3, 360);
    telemetry.pingSent(4, 360);
    telemetry.pongReceived(4, 1360);
    telemetry.pingSent(5, 1360);
    telemetry.pongReceived(5, 1520);

    expect(telemetry.report(2000)).toMatchObject({
      latencyMs: 140,
      samples: 5,
    });
  });

  it("averages the two middle RTT samples for an even sample median", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 1000);
    telemetry.pingSent(2, 1010);
    telemetry.pingSent(3, 1020);
    telemetry.pingSent(4, 1030);
    telemetry.pongReceived(1, 1100);
    telemetry.pongReceived(2, 1130);
    telemetry.pongReceived(3, 1160);
    telemetry.pongReceived(4, 1190);

    expect(telemetry.report(2000)).toMatchObject({
      latencyMs: 130,
      samples: 4,
    });
  });

  it("computes jitter from adjacent successful samples in send order", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pingSent(2, 10);
    telemetry.pingSent(3, 20);
    telemetry.pongReceived(1, 100);
    telemetry.pongReceived(3, 150);
    telemetry.pongReceived(2, 170);

    expect(telemetry.report(4000)).toEqual({
      latencyMs: 130,
      jitterMs: 45,
      samples: 3,
    });
  });

  it("returns no report when only one fresh success exists", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 1000);
    telemetry.pongReceived(1, 1100);

    expect(telemetry.report(1100)).toBeNull();
  });

  it("reports only latency jitter and sample count", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 1000);
    telemetry.pingSent(2, 1100);
    telemetry.pongReceived(1, 1200);
    telemetry.pongReceived(2, 1400);

    expect(Object.keys(telemetry.report(1400) ?? {}).sort()).toEqual(["jitterMs", "latencyMs", "samples"]);
  });

  it("keeps a timed-out ping terminal when its pong arrives late", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(7, 0);
    telemetry.advance(3001);
    telemetry.pongReceived(7, 3100);

    expect(telemetry.getState()).toMatchObject({
      unresolved: 0,
      timedOutIds: [7],
      successes: [],
    });
  });

  it("does not send a fifth probe while four probes are unresolved", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pingSent(2, 1000);
    telemetry.pingSent(3, 2000);
    telemetry.pingSent(4, 2999);

    expect(telemetry.pingSent(5, 3000)).toEqual({});
    expect(telemetry.getState().unresolved).toBe(4);
  });

  it("does not send a fifth fresh probe while four fresh probes are unresolved", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pingSent(2, 100);
    telemetry.pingSent(3, 200);
    telemetry.pingSent(4, 300);

    expect(telemetry.pingSent(5, 400)).toEqual({});
    expect(telemetry.getState().unresolved).toBe(4);
  });

  it("times out a pong received exactly at the three second deadline without advance", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pongReceived(1, 3000);

    expect(telemetry.getState()).toMatchObject({
      unresolved: 0,
      timedOutIds: [1],
      successes: [],
    });
  });

  it("accepts a pong received before the three second deadline", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pongReceived(1, 2999);

    expect(telemetry.getState()).toMatchObject({
      unresolved: 0,
      timedOutIds: [],
      successes: [{ id: 1, sentAtMs: 0, receivedAtMs: 2999, rttMs: 2999 }],
    });
  });

  it("ignores a duplicate pong after the first success", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(9, 1000);
    telemetry.pongReceived(9, 1100);
    telemetry.pongReceived(9, 1200);

    expect(telemetry.getState().successes).toEqual([
      { id: 9, sentAtMs: 1000, receivedAtMs: 1100, rttMs: 100 },
    ]);
  });

  it("ignores a pong from an old socket epoch", () => {
    const telemetry = new Telemetry();

    telemetry.reset(3);
    telemetry.pingSent(11, 1000, 3);
    telemetry.pongReceived(11, 1100, 2);

    expect(telemetry.getState()).toMatchObject({
      unresolved: 1,
      successes: [],
    });
  });

  it("expires successful samples older than ten seconds before reporting", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pongReceived(1, 100);
    telemetry.pingSent(2, 11000);
    telemetry.pongReceived(2, 11120);

    expect(telemetry.report(11120)).toBeNull();
    expect(telemetry.getState().successes.map((sample) => sample.id)).toEqual([2]);
  });

  it("does not rearm a completed ID after its success sample expires", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pongReceived(1, 100);
    telemetry.report(10101);
    telemetry.pingSent(1, 11000);
    telemetry.pongReceived(1, 11100);

    expect(telemetry.getState()).toMatchObject({
      unresolved: 0,
      successes: [],
    });
  });

  it("expires successful samples by send time before reporting", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pongReceived(1, 2000);
    telemetry.pingSent(2, 3000);
    telemetry.pongReceived(2, 3100);

    expect(telemetry.report(10001)).toBeNull();
    expect(telemetry.getState().successes.map((sample) => sample.id)).toEqual([2]);
  });

  it("keeps only the last ten successful samples by send order", () => {
    const telemetry = new Telemetry();

    for (let id = 1; id <= 11; id += 1) {
      telemetry.pingSent(id, id * 100);
      telemetry.pongReceived(id, id * 100 + id);
    }

    expect(telemetry.getState().successes.map((sample) => sample.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("does not rearm a completed ID after a same-epoch reset", () => {
    const telemetry = new Telemetry();

    telemetry.pingSent(1, 0);
    telemetry.pongReceived(1, 100);
    telemetry.reset();
    telemetry.pingSent(1, 1000);
    telemetry.pongReceived(1, 1100);

    expect(telemetry.getState()).toMatchObject({
      unresolved: 0,
      successes: [],
    });
  });

  it("allows a completed numeric ID again after the epoch changes", () => {
    const telemetry = new Telemetry();

    telemetry.reset(1);
    telemetry.pingSent(1, 0);
    telemetry.pongReceived(1, 100);
    telemetry.reset(2);
    telemetry.pingSent(1, 1000);
    telemetry.pongReceived(1, 1100);

    expect(telemetry.getState().successes).toEqual([
      { id: 1, sentAtMs: 1000, receivedAtMs: 1100, rttMs: 100 },
    ]);
  });

  it("does not rearm a completed ID after ten newer success samples evict it", () => {
    const telemetry = new Telemetry();

    for (let id = 1; id <= 11; id += 1) {
      telemetry.pingSent(id, id * 100);
      telemetry.pongReceived(id, id * 100 + id);
    }
    telemetry.pingSent(1, 2000);
    telemetry.pongReceived(1, 2100);

    expect(telemetry.getState().successes.map((sample) => sample.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
