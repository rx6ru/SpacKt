import { describe, expect, it } from "vitest";
import { ConnectionLifecycle } from "./lifecycle";

function controller(randomValues: number[] = [0]) {
  let nowMs = 0;
  let randomIndex = 0;
  const lifecycle = new ConnectionLifecycle({
    now: () => nowMs,
    random: () => randomValues[randomIndex++] ?? randomValues.at(-1) ?? 0,
    protocolVersion: 1,
  });

  return {
    lifecycle,
    setNow(value: number) {
      nowMs = value;
    },
    advanceBy(value: number) {
      nowMs += value;
    },
  };
}

describe("ConnectionLifecycle reconnect policy", () => {
  it("ignores a hello callback from an older socket epoch after a new connect starts", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.connect();
    const effects = lifecycle.hello({ session: "old", protocolVersion: 1 }, 1);

    expect(effects).toEqual({});
    expect(lifecycle.getState()).toMatchObject({
      epoch: 2,
      session: null,
      status: "connecting",
    });
  });

  it("ignores a close callback from an older socket epoch after a new connect starts", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.connect();
    const effects = lifecycle.socketClosed({ code: 1006 }, 1);

    expect(effects).toEqual({});
    expect(lifecycle.getState()).toMatchObject({
      epoch: 2,
      status: "connecting",
      reconnectAttempts: 0,
    });
  });

  it("uses full jitter capped at 10 seconds for ordinary reconnect backoff", () => {
    const { lifecycle } = controller([0, 0.5, 0.99, 0.99, 0.99, 0.99]);

    const delays = Array.from({ length: 6 }, () => {
      lifecycle.connect();
      return lifecycle.socketClosed({ code: 1006 }).scheduleReconnect?.delayMs;
    });

    expect(delays[0]).toBe(0);
    expect(delays[1]).toBe(500);
    expect(delays[5]).toBeLessThanOrEqual(10_000);
  });

  it("resets reconnect attempts only after 30 seconds of healthy synchronized live operation", () => {
    const { lifecycle, setNow } = controller([0.5, 0.5]);

    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.socketClosed({ code: 1006 });
    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.healthySynchronized();
    setNow(29_999);
    lifecycle.advance();
    const beforeThirtySeconds = lifecycle.socketClosed({ code: 1006 });
    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.healthySynchronized();
    setNow(60_000);
    lifecycle.advance();
    const afterThirtySeconds = lifecycle.socketClosed({ code: 1006 });

    expect(beforeThirtySeconds.scheduleReconnect?.delayMs).toBe(500);
    expect(afterThirtySeconds.scheduleReconnect?.delayMs).toBe(250);
  });

  it("requires a full 30 seconds after unhealthy evidence before resetting reconnect attempts", () => {
    const { lifecycle, setNow } = controller();

    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.socketClosed({ code: 1006 });
    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.healthySynchronized();
    setNow(29_000);
    lifecycle.advance();
    lifecycle.healthySynchronized(false);
    lifecycle.healthySynchronized();
    setNow(58_999);
    lifecycle.advance();

    expect(lifecycle.getState().reconnectAttempts).toBe(1);

    setNow(59_000);
    lifecycle.advance();

    expect(lifecycle.getState().reconnectAttempts).toBe(0);
  });

  it("reconnects after 4001 only when the page is visible", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.visibilityChanged(true);
    const hiddenClose = lifecycle.socketClosed({ code: 4001 });
    const visibleAgain = lifecycle.visibilityChanged(false);

    expect(hiddenClose.scheduleReconnect).toBeUndefined();
    expect(visibleAgain.openSocket).toEqual({ epoch: 2 });
  });

  it("does not return old-epoch effects when visibility returns after a hidden 4001 close", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.visibilityChanged(true);
    lifecycle.socketClosed({ code: 4001 });
    const effects = lifecycle.visibilityChanged(false);

    expect(effects.openSocket).toEqual({ epoch: 2 });
    const effectEpochs = [effects.sendControl?.epoch, effects.startProbes?.epoch, effects.clearEvidence?.epoch].filter(
      (epoch): epoch is number => epoch !== undefined,
    );
    expect(effectEpochs).not.toContain(1);
    for (const epoch of effectEpochs) {
      expect(epoch).toBe(2);
    }
  });

  it("opens a replacement socket immediately when 4001 closes a visible online socket", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    const effects = lifecycle.socketClosed({ code: 4001 });

    expect(effects.scheduleReconnect).toBeUndefined();
    expect(effects.openSocket).toEqual({ epoch: 2 });
  });

  it("does not open a replacement socket when 4001 closes a hidden socket", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.visibilityChanged(true);
    const effects = lifecycle.socketClosed({ code: 4001 });

    expect(effects.openSocket).toBeUndefined();
    expect(effects.scheduleReconnect).toBeUndefined();
  });

  it("makes protocol mismatch 4002 terminal without automatic retry", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    const effects = lifecycle.socketClosed({ code: 4002 });

    expect(effects.scheduleReconnect).toBeUndefined();
    expect(lifecycle.getState()).toMatchObject({
      status: "terminal",
      terminalReason: "protocol_mismatch",
    });
  });

  it("delays 4008 retries by at least 10 seconds and caps them at 30 seconds", () => {
    const { lifecycle } = controller([0, 0.99, 0.99, 0.99, 0.99]);

    const delays = Array.from({ length: 5 }, () => {
      lifecycle.connect();
      return lifecycle.socketClosed({ code: 4008 }).scheduleReconnect?.delayMs ?? 0;
    });

    expect(delays[0]).toBeGreaterThanOrEqual(10_000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
  });

  it("allows one automatic 4009 fresh reload and then requires manual retry when 4009 repeats before healthy reset", () => {
    const { lifecycle } = controller([0.25, 0.25]);

    lifecycle.connect();
    const first = lifecycle.socketClosed({ code: 4009 });
    lifecycle.connect();
    const repeated = lifecycle.socketClosed({ code: 4009 });

    expect(first).toMatchObject({
      scheduleReconnect: { delayMs: 15_000, reason: "payload_too_large" },
    });
    expect(lifecycle.getState().staleCachedData).toBe(true);
    expect(repeated.scheduleReconnect).toBeUndefined();
    expect(lifecycle.getState().manualRetryRequired).toBe(true);
  });

  it("does not let connect bypass manual retry after repeated 4009", () => {
    const { lifecycle } = controller([0.25, 0.25]);

    lifecycle.connect();
    lifecycle.socketClosed({ code: 4009 });
    lifecycle.connect();
    lifecycle.socketClosed({ code: 4009 });
    const effects = lifecycle.connect();

    expect(effects.openSocket).toBeUndefined();
    expect(lifecycle.getState().manualRetryRequired).toBe(true);
  });

  it("uses retry for manual 4009 recovery with a fresh state reload", () => {
    const { lifecycle } = controller([0.25, 0.25]);

    lifecycle.connect();
    lifecycle.socketClosed({ code: 4009 });
    lifecycle.connect();
    lifecycle.socketClosed({ code: 4009 });
    const effects = lifecycle.retry();

    expect(effects.openSocket).toEqual({ epoch: 3, reloadFreshState: true });
    expect(lifecycle.getState()).toMatchObject({
      manualRetryRequired: false,
      staleCachedData: true,
      status: "connecting",
    });
  });

  it("does not retry when protocol 4002 requires reload", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.socketClosed({ code: 4002 });
    const effects = lifecycle.retry();

    expect(effects.openSocket).toBeUndefined();
    expect(lifecycle.getState()).toMatchObject({
      status: "terminal",
      terminalReason: "protocol_mismatch",
    });
  });

  it("reloads fresh state on the next connect after 4009", () => {
    const { lifecycle } = controller([0.25]);

    lifecycle.connect();
    lifecycle.socketClosed({ code: 4009 });
    const effects = lifecycle.connect();

    expect(effects.openSocket).toEqual({ epoch: 2, reloadFreshState: true });
    expect(lifecycle.getState().staleCachedData).toBe(true);
  });

  it("reenables one automatic 4009 retry after 30 seconds of healthy synchronized operation", () => {
    const { lifecycle, setNow } = controller([0.25, 0.5]);

    lifecycle.connect();
    lifecycle.socketClosed({ code: 4009 });
    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.healthySynchronized();
    setNow(30_000);
    lifecycle.advance();
    const effects = lifecycle.socketClosed({ code: 4009 });

    expect(effects.scheduleReconnect).toEqual({
      epoch: 2,
      delayMs: 20_000,
      reason: "payload_too_large",
    });
    expect(lifecycle.getState().manualRetryRequired).toBe(false);
  });

  it("keeps the original healthy start when healthy synchronized evidence repeats", () => {
    const { lifecycle, setNow } = controller([0.25, 0.5]);

    lifecycle.connect();
    lifecycle.socketClosed({ code: 4009 });
    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.healthySynchronized();
    setNow(10_000);
    lifecycle.healthySynchronized();
    setNow(20_000);
    lifecycle.healthySynchronized(true);
    setNow(30_000);
    lifecycle.advance();
    const effects = lifecycle.socketClosed({ code: 4009 });

    expect(effects.scheduleReconnect).toEqual({
      epoch: 2,
      delayMs: 20_000,
      reason: "payload_too_large",
    });
    expect(lifecycle.getState().manualRetryRequired).toBe(false);
  });

  it("opens an immediate connection when the browser returns online", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.onlineChanged(false);
    const effects = lifecycle.onlineChanged(true);

    expect(effects.openSocket).toEqual({ epoch: 2 });
    expect(lifecycle.getState().status).toBe("connecting");
  });

  it("does not open a socket while hidden or offline", () => {
    const hidden = controller().lifecycle;
    const offline = controller().lifecycle;

    hidden.visibilityChanged(true);
    offline.onlineChanged(false);

    expect(hidden.connect().openSocket).toBeUndefined();
    expect(offline.connect().openSocket).toBeUndefined();
  });

  it("does not schedule retry when the socket closes while hidden or offline", () => {
    const hidden = controller().lifecycle;
    const offline = controller().lifecycle;

    hidden.connect();
    hidden.visibilityChanged(true);
    offline.connect();
    offline.onlineChanged(false);

    expect(hidden.socketClosed({ code: 1006 }).scheduleReconnect).toBeUndefined();
    expect(offline.socketClosed({ code: 1006 }).scheduleReconnect).toBeUndefined();
  });
});

describe("ConnectionLifecycle visibility and session reset", () => {
  it("sends hidden visibility and stops app probes when the tab becomes hidden", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    const effects = lifecycle.visibilityChanged(true);

    expect(effects.sendControl).toMatchObject({
      message: { type: "visibility", hidden: true },
    });
    expect(effects.stopProbes).toEqual({ epoch: 1 });
    expect(effects.cancelTimers?.targets).toContain("ping");
  });

  it("clears RTT and freshness evidence before starting probes when the tab becomes visible", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.visibilityChanged(true);
    const effects = lifecycle.visibilityChanged(false);

    expect(effects.clearEvidence).toEqual({
      epoch: 1,
      targets: ["rtt", "freshness"],
    });
    expect(effects.startProbes).toEqual({ epoch: 1 });
  });

  it("resets every browser engine when a new session arrives", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.socketClosed({ code: 1006 });
    lifecycle.connect();
    const effects = lifecycle.hello({ session: "B", protocolVersion: 1 });

    expect(effects.resetEngines).toEqual({
      epoch: 2,
      session: "B",
      engines: ["book", "candles", "trades", "telemetry", "freshness"],
    });
  });

  it("does not reset reconnect attempts when a new session arrives before healthy recovery", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.socketClosed({ code: 1006 });
    lifecycle.connect();
    lifecycle.hello({ session: "B", protocolVersion: 1 });

    expect(lifecycle.getState()).toMatchObject({
      session: "B",
      reconnectAttempts: 1,
    });
  });

  it("makes a hello protocol version mismatch terminal without resetting engines", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    const effects = lifecycle.hello({ session: "A", protocolVersion: 2 }, 1);

    expect(effects.resetEngines).toBeUndefined();
    expect(effects.openSocket).toBeUndefined();
    expect(lifecycle.getState()).toMatchObject({
      status: "terminal",
      terminalReason: "reload_required",
    });
  });

  it("does not retry when hello protocol mismatch requires reload", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 2 }, 1);
    const effects = lifecycle.retry();

    expect(effects.openSocket).toBeUndefined();
    expect(lifecycle.getState()).toMatchObject({
      status: "terminal",
      terminalReason: "reload_required",
    });
  });

  it("treats a persisted pageshow as a fresh connection with old callbacks invalidated", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    lifecycle.hello({ session: "A", protocolVersion: 1 });
    lifecycle.pageHide({ persisted: true });
    const effects = lifecycle.pageShow({ persisted: true });

    expect(effects.openSocket).toEqual({ epoch: 2, reloadFreshState: true });
    expect(effects.clearEvidence).toEqual({
      epoch: 2,
      targets: ["rtt", "freshness"],
    });
  });
});

describe("ConnectionLifecycle cleanup contract", () => {
  it("returns concrete cleanup effects for the outer runtime on pagehide", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    const effects = lifecycle.pageHide({ persisted: false });

    expect(effects).toMatchObject({
      cancelTimers: { epoch: 1 },
      abortRequests: { epoch: 1, reason: "pagehide" },
      closeSocket: { epoch: 1, code: 1001, reason: "pagehide" },
    });
  });

  it("returns concrete cleanup effects and ignores later events after disposal", () => {
    const { lifecycle } = controller();

    lifecycle.connect();
    const effects = lifecycle.dispose();
    const afterDispose = lifecycle.socketClosed({ code: 1006 });

    expect(effects.cleanup).toEqual({
      epoch: 1,
      timers: true,
      socket: true,
      domListeners: true,
      requests: true,
      charts: true,
    });
    expect(afterDispose).toEqual({});
    expect(lifecycle.getState().disposed).toBe(true);
  });
});
