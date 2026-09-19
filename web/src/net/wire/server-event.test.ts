import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProtocolVersionError, decodeServerEvent } from "./server-event";

const fixtureRoot = join(process.cwd(), "..", "protocol", "fixtures");

function readFixture(file: string): string {
  return readFileSync(join(fixtureRoot, file), "utf8");
}

function encode(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function utf8Bytes(raw: string): number {
  return new TextEncoder().encode(raw).length;
}

function expectOrdinaryError(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProtocolVersionError);
    expect((error as Error).message).not.toMatch(/not implemented/i);
    return;
  }

  throw new Error("Expected ordinary decode error");
}

function expectProtocolVersionError(raw: string, receivedVersion: number): void {
  try {
    decodeServerEvent(raw, "hello");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolVersionError);
    expect((error as { receivedVersion?: unknown }).receivedVersion).toBe(receivedVersion);
    return;
  }

  throw new Error("Expected protocol version error");
}

function unsupportedHello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "hello",
    v: 2,
    session: "s1",
    symbol: "BTC-USD",
    connId: "c1",
    tier: "degraded",
    autoTier: "degraded",
    forced: null,
    hidden: false,
    flushMs: 500,
    ...overrides,
  };
}

function deepUnsupportedHelloRaw(): string {
  let nested: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 13; index += 1) {
    nested = { child: nested };
  }

  return encode({ ...unsupportedHello(), nested });
}

describe("server event decoder", () => {
  it("requires the first server message to be a hello", () => {
    expectOrdinaryError(() => decodeServerEvent(readFixture("valid-server-subscribed.json"), "hello"));
  });

  it("maps a supported hello only after all hello fields validate", () => {
    expect(decodeServerEvent(readFixture("valid-server-hello.json"), "hello")).toEqual({
      type: "hello",
      session: "s1",
      symbol: "BTC-USD",
      protocolVersion: 1,
      connId: "c1",
      tier: "degraded",
      autoTier: "degraded",
      forced: null,
      hidden: false,
      flushMs: 500,
    });
  });

  it("throws ProtocolVersionError with the received integer version for unsupported hello", () => {
    expectProtocolVersionError(encode(unsupportedHello()), 2);
  });

  it("rejects a supported hello when non-version fields are invalid", () => {
    expectOrdinaryError(() => decodeServerEvent(encode(unsupportedHello({ v: 1, session: "bad session" })), "hello"));
  });

  it.each([
    ["absent version", encode({ ...unsupportedHello(), v: undefined })],
    ["non-integer version", encode({ ...unsupportedHello(), v: 1.5 })],
    ["string version", encode({ ...unsupportedHello(), v: "2" })],
    ["malformed JSON", "{"],
  ] as const)("rejects %s as an ordinary malformed hello", (_name, raw) => {
    expectOrdinaryError(() => decodeServerEvent(raw, "hello"));
  });

  it("rejects oversized unsupported hello before interpreting the version", () => {
    const raw = encode(unsupportedHello({ padding: "x".repeat(1_048_577) }));

    expectOrdinaryError(() => decodeServerEvent(raw, "hello"));
  });

  it("rejects deeply nested unsupported hello before interpreting the version", () => {
    expectOrdinaryError(() => decodeServerEvent(deepUnsupportedHelloRaw(), "hello"));
  });

  it("rejects duplicate hello messages after the active phase starts", () => {
    expectOrdinaryError(() => decodeServerEvent(readFixture("valid-server-hello.json"), "active"));
  });

  it.each([
    ["subscribed", "valid-server-subscribed.json", { type: "subscribed", session: "s1", interval: "1s", requestId: 1 }],
    ["pong", "valid-server-pong.json", { type: "pong", session: "s1", id: 1 }],
    ["tier", "valid-server-tier.json", {
      type: "tier",
      session: "s1",
      tier: "minimal",
      autoTier: "degraded",
      forced: "minimal",
      hidden: false,
      flushMs: 2000,
      reason: "Debug tier forced.",
    }],
    ["heartbeat", "valid-server-heartbeat.json", {
      type: "heartbeat",
      session: "s1",
      marketRev: 84,
      bookSeq: 104,
      candleRequestId: null,
      candleLatestRev: null,
      feedReady: true,
    }],
    ["book reset", "valid-server-book-reset.json", { type: "book_reset", session: "s1", reason: "cursor_expired" }],
    ["candles reset", "valid-server-candles-reset.json", { type: "candles_reset", session: "s1", interval: "1s", requestId: 1, reason: "cursor_expired" }],
    ["server error", "valid-server-error.json", { type: "error", session: "s1", code: "bad_message", message: "Malformed message." }],
  ] as const)("maps active %s messages", (_name, file, expected) => {
    expect(decodeServerEvent(readFixture(file), "active")).toEqual(expected);
  });

  it("maps active updates with the actual UTF-8 byte count from the raw frame", () => {
    const raw = readFixture("valid-server-update.json");

    expect(decodeServerEvent(raw, "active")).toEqual({
      type: "update",
      session: "s1",
      marketRev: 84,
      book: {
        from: 101,
        to: 104,
        bids: [{ priceTicks: 9900, quantityLots: 10000 }],
        asks: [],
      },
      candles: {
        requestId: 3,
        interval: "1s",
        items: [{
          timeMs: 1_700_000_000_000,
          openTicks: 10000,
          highTicks: 10400,
          lowTicks: 9900,
          closeTicks: 9900,
          volumeLots: 60000,
          rev: 84,
          closed: true,
        }],
      },
      trades: [{ id: 8, timeMs: 1_700_000_000_800, priceTicks: 9900, quantityLots: 30000, side: "sell" }],
      skipped: 0,
      wireBytes: utf8Bytes(raw),
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["unknown server type", encode({ type: "mystery", session: "s1" })],
    ["schema-invalid active payload", encode({ type: "tier", session: "s1", tier: "minimal", autoTier: "degraded", forced: "minimal", hidden: false, flushMs: 2000, reason: "r".repeat(161) })],
  ] as const)("rejects %s during the active phase", (_name, raw) => {
    expectOrdinaryError(() => decodeServerEvent(raw, "active"));
  });
});
