import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeWire, encodeWire, toTrade } from "./schema";

type FixtureCase = {
  name: string;
  kind: string;
  valid: boolean;
  file: string;
};

const fixtureRoot = join(process.cwd(), "..", "protocol", "fixtures");
const cases = JSON.parse(readFileSync(join(fixtureRoot, "cases.json"), "utf8")) as FixtureCase[];

function readFixture(file: string): string {
  return readFileSync(join(fixtureRoot, file), "utf8");
}

describe("wire schema fixtures", () => {
  it.each(cases)("$name", (testCase) => {
    const attempt = () => decodeWire(testCase.kind, readFixture(testCase.file));

    if (!testCase.valid) {
      expect(attempt).toThrow();
      return;
    }

    const decoded = attempt();
    const encoded = encodeWire(testCase.kind, decoded);
    expect(decodeWire(testCase.kind, encoded)).toEqual(decoded);
  });
});

describe("wire encoding rejection", () => {
  it("rejects invalid values instead of serializing unknown fields", () => {
    expect(() =>
      encodeWire("client", {
        type: "ping",
        session: "s1",
        id: 1,
        extra: true,
      }),
    ).toThrow();
  });
});

describe("wire duplicate and mapping rules", () => {
  it("uses the last complete nested object before strict validation", () => {
    const decoded = decodeWire("meta", readFixture("valid-meta-duplicate-flush.json"));
    const tierPolicy = decoded.tierPolicy as Record<string, unknown>;
    const flushMs = tierPolicy.flushMs as Record<string, unknown>;

    expect(flushMs).toEqual({ full: 100, degraded: 500, minimal: 2000 });
    expect(flushMs).not.toHaveProperty("debug");
  });

  it("maps a wire trade to ticks and lots without binary float drift", () => {
    const decoded = decodeWire("trades", readFixture("valid-trades-max-safe.json"));
    const trades = decoded.trades as Record<string, unknown>[];

    expect(
      toTrade(trades[0]),
    ).toEqual({
      id: 9007199254740991,
      timeMs: 1700000000800,
      priceTicks: 6423050,
      quantityLots: 12300,
      side: "buy",
    });
  });
});

describe("wire rejection boundaries", () => {
  it("rejects unsafe identifiers, invalid enums, and invalid decimal alphabets", () => {
    const invalidInputs = [
      ["trades", '{"session":"s1","symbol":"BTC-USD","trades":[{"id":9007199254740992,"t":1700000000800,"p":"64230.50","q":"1.2300","side":"sell"}]}'],
      ["trades", '{"session":"s1","symbol":"BTC-USD","trades":[{"id":8,"t":1700000000800,"p":"64230.50","q":"1.2300","side":"BUY"}]}'],
      ["client", '{"type":"subscribe","session":"s1","interval":"01s","requestId":1}'],
      ["client", '{"type":"debug","session":"s1","action":"forceTier","value":"Full"}'],
      ["trades", '{"session":"s1","symbol":"BTC-USD","trades":[{"id":8,"t":1700000000800,"p":"1e2","q":"1.2300","side":"sell"}]}'],
    ] as const;

    for (const [kind, raw] of invalidInputs) {
      expect(() => decodeWire(kind, raw)).toThrow();
    }
  });

  it("rejects inbound client frames over 4096 bytes before parsing", () => {
    const validPing = '{"type":"ping","session":"s1","id":1}';
    const raw = validPing + " ".repeat(4097 - validPing.length);

    expect(() => decodeWire("client", raw)).toThrow();
  });

  it("rejects JSON deeper than twelve levels before application processing", () => {
    const raw = '{"type":"ping","session":"s1","id":1,"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":{"j":{"k":{"l":{"m":1}}}}}}}}}}}}}';

    expect(() => decodeWire("client", raw)).toThrow(/depth/i);
  });
});

describe("display text unicode boundaries", () => {
  it("accepts 160 Unicode characters when the UTF-8 length is 640 bytes", () => {
    const message = "😀".repeat(160);
    expect(Array.from(message)).toHaveLength(160);
    expect(new TextEncoder().encode(message)).toHaveLength(640);

    expect(() => decodeWire("httpError", JSON.stringify({ error: { code: "bad_request", message } }))).not.toThrow();
  });

  it("rejects 161 Unicode characters over the UTF-8 byte limit", () => {
    const message = "😀".repeat(161);
    expect(Array.from(message)).toHaveLength(161);
    expect(new TextEncoder().encode(message).length).toBeGreaterThan(640);

    expect(() => decodeWire("httpError", JSON.stringify({ error: { code: "bad_request", message } }))).toThrow();
  });
});

describe("documented schema mutation rejections", () => {
  const invalidMutations: Array<{
    name: string;
    kind: string;
    file: string;
    mutate: (value: Record<string, unknown>) => void;
  }> = [
    { name: "meta rejects non increasing flush rates", kind: "meta", file: "valid-meta.json", mutate: (value) => { objectAt(value, "tierPolicy", "flushMs").full = 500; } },
    { name: "meta rejects recovery threshold at entry boundary", kind: "meta", file: "valid-meta.json", mutate: (value) => { objectAt(value, "tierPolicy", "recoverFull").latencyBelowMs = 400; } },
    { name: "meta rejects zero duration", kind: "meta", file: "valid-meta.json", mutate: (value) => { objectAt(value, "tierPolicy").pingEveryMs = 0; } },
    { name: "meta rejects duration above maximum", kind: "meta", file: "valid-meta.json", mutate: (value) => { objectAt(value, "tierPolicy").hiddenCloseMs = 3600001; } },
    { name: "meta rejects minimum samples below lower bound", kind: "meta", file: "valid-meta.json", mutate: (value) => { objectAt(value, "tierPolicy").minimumReportSamples = 1; } },
    { name: "meta rejects rtt sample window above maximum", kind: "meta", file: "valid-meta.json", mutate: (value) => { objectAt(value, "tierPolicy").rttWindowSamples = 11; } },
    { name: "meta rejects invalid session charset", kind: "meta", file: "valid-meta.json", mutate: (value) => { value.session = "bad session"; } },
    { name: "meta rejects session length above maximum", kind: "meta", file: "valid-meta.json", mutate: (value) => { value.session = "a".repeat(65); } },
    { name: "meta rejects wrong intervals type", kind: "meta", file: "valid-meta.json", mutate: (value) => { value.intervals = "1s"; } },
    { name: "health rejects missing status", kind: "health", file: "valid-health.json", mutate: (value) => { delete value.status; } },
    { name: "readiness rejects unknown status", kind: "readiness", file: "valid-readiness.json", mutate: (value) => { value.status = "warming"; } },
    { name: "http error rejects control characters in message", kind: "httpError", file: "valid-http-error.json", mutate: (value) => { objectAt(value, "error").message = "bad\nrequest"; } },
    { name: "book rejects duplicate bid prices", kind: "book", file: "valid-book.json", mutate: (value) => {
      const bids = arrayAt(value, "bids");
      (bids[1] as unknown[])[0] = (bids[0] as unknown[])[0];
    } },
    { name: "book rejects unsorted bids", kind: "book", file: "valid-book.json", mutate: (value) => { (arrayAt(value, "bids")[1] as unknown[])[0] = "100.00"; } },
    { name: "book rejects crossed best levels", kind: "book", file: "valid-book.json", mutate: (value) => { (arrayAt(value, "asks")[0] as unknown[])[0] = "98.00"; } },
    { name: "book rejects zero quantity snapshot level", kind: "book", file: "valid-book.json", mutate: (value) => { (arrayAt(value, "bids")[0] as unknown[])[1] = "0"; } },
    { name: "history rejects candle low above open", kind: "history", file: "valid-history.json", mutate: (value) => { firstCandle(value).l = "101.00"; } },
    { name: "history rejects zero volume with unequal OHLC", kind: "history", file: "valid-history.json", mutate: (value) => {
      const candle = firstCandle(value);
      candle.v = "0";
      candle.c = "101.00";
    } },
    { name: "history rejects unaligned candle time", kind: "history", file: "valid-history.json", mutate: (value) => { firstCandle(value).t = 1700000000001; } },
    { name: "recent trades reject ascending order", kind: "trades", file: "valid-trades.json", mutate: (value) => {
      value.trades = [
        { id: 8, t: 1700000000800, p: "99.00", q: "1.0000", side: "buy" },
        { id: 9, t: 1700000000900, p: "100.00", q: "1.0000", side: "sell" },
      ];
    } },
    { name: "recent trades reject duplicate IDs", kind: "trades", file: "valid-trades.json", mutate: (value) => {
      value.trades = [
        { id: 8, t: 1700000000800, p: "99.00", q: "1.0000", side: "buy" },
        { id: 8, t: 1700000000700, p: "98.00", q: "1.0000", side: "sell" },
      ];
    } },
    { name: "server update rejects candle rev above market rev", kind: "server", file: "valid-server-update.json", mutate: (value) => { firstUpdateCandle(value).rev = 85; } },
    { name: "server update rejects empty payload", kind: "server", file: "valid-server-update.json", mutate: (value) => {
      delete value.book;
      delete value.candles;
      delete value.trades;
      delete value.skipped;
    } },
    { name: "server update rejects skipped without trades", kind: "server", file: "valid-server-update.json", mutate: (value) => { delete value.trades; } },
    { name: "server update rejects explicit null book with valid candles", kind: "server", file: "valid-server-update.json", mutate: (value) => {
      value.book = null;
      delete value.trades;
      delete value.skipped;
    } },
    { name: "server update rejects explicit null candles with valid book", kind: "server", file: "valid-server-update.json", mutate: (value) => {
      value.candles = null;
      delete value.trades;
      delete value.skipped;
    } },
    { name: "server update rejects explicit null trades with valid candles", kind: "server", file: "valid-server-update.json", mutate: (value) => {
      value.trades = null;
      delete value.book;
      delete value.skipped;
    } },
    { name: "server update rejects explicit null skipped with valid book", kind: "server", file: "valid-server-update.json", mutate: (value) => {
      value.skipped = null;
      delete value.candles;
      delete value.trades;
    } },
    { name: "server update rejects duplicate trade IDs", kind: "server", file: "valid-server-update.json", mutate: (value) => {
      value.trades = [
        { id: 8, t: 1700000000800, p: "99.00", q: "1.0000", side: "buy" },
        { id: 8, t: 1700000000900, p: "100.00", q: "1.0000", side: "sell" },
      ];
    } },
    { name: "client ping rejects null id", kind: "client", file: "valid-client-ping.json", mutate: (value) => { value.id = null; } },
    { name: "client report rejects samples below lower bound", kind: "client", file: "valid-client-report.json", mutate: (value) => { value.samples = 1; } },
    { name: "client report rejects samples above upper bound", kind: "client", file: "valid-client-report.json", mutate: (value) => { value.samples = 11; } },
    { name: "server hello rejects missing version", kind: "server", file: "valid-server-hello.json", mutate: (value) => { delete value.v; } },
    { name: "server hello rejects wrong hidden type", kind: "server", file: "valid-server-hello.json", mutate: (value) => { value.hidden = "false"; } },
    { name: "server error rejects invalid error code", kind: "server", file: "valid-server-error.json", mutate: (value) => { value.code = "not_a_code"; } },
    { name: "server hello rejects overlong connection id", kind: "server", file: "valid-server-hello.json", mutate: (value) => { value.connId = "c".repeat(65); } },
    { name: "server tier rejects overlong reason", kind: "server", file: "valid-server-tier.json", mutate: (value) => { value.reason = "r".repeat(161); } },
  ];

  it.each(invalidMutations)("$name", ({ kind, file, mutate }) => {
    expect(() => decodeWire(kind, mutatedFixture(file, mutate))).toThrow();
  });

  const requiredMetaPaths = [
    ["session"], ["symbol"], ["tickSize"], ["lotSize"], ["intervals"], ["referencePrice"], ["tierPolicy"], ["retention"],
    ["tierPolicy", "initialTier"], ["tierPolicy", "flushMs"], ["tierPolicy", "enterDegraded"], ["tierPolicy", "enterMinimal"],
    ["tierPolicy", "recoverFull"], ["tierPolicy", "recoverDegraded"], ["tierPolicy", "downgradeDwellMs"], ["tierPolicy", "upgradeDwellMs"],
    ["tierPolicy", "missingReportStepMs"], ["tierPolicy", "missingReportMinimalMs"], ["tierPolicy", "pingEveryMs"],
    ["tierPolicy", "pongTimeoutMs"], ["tierPolicy", "reportEveryMs"], ["tierPolicy", "rttWindowSamples"],
    ["tierPolicy", "minimumReportSamples"], ["tierPolicy", "hiddenCloseMs"], ["tierPolicy", "flushMs", "full"],
    ["tierPolicy", "flushMs", "degraded"], ["tierPolicy", "flushMs", "minimal"], ["retention", "historyCandles"],
    ["retention", "deliveryClosedCandles"], ["retention", "recentTrades"], ["retention", "bookChanges"],
    ["retention", "maximumBookLevelsPerSide"], ["retention", "historyCandles", "1s"], ["retention", "historyCandles", "1m"],
    ["retention", "historyCandles", "5m"],
  ];

  it.each(requiredMetaPaths.map((path) => [path.join("."), path] as const))("rejects meta with missing %s", (_name, path) => {
    expect(() => decodeWire("meta", mutatedFixture("valid-meta.json", (value) => deletePath(value, path)))).toThrow();
  });

  it("rejects unsupported kind, invalid JSON, and trailing documents", () => {
    expect(() => decodeWire("unknown", readFixture("valid-health.json"))).toThrow();
    expect(() => decodeWire("health", '{"status":"ok"')).toThrow();
    expect(() => decodeWire("health", '{"status":"ok"}{"status":"ok"}')).toThrow();
  });
});

describe("supported interval candle decoding", () => {
  it.each([
    ["1s", 1700000000000],
    ["1m", 1700000040000],
    ["5m", 1700000100000],
  ] as const)("accepts %s history candles with UTC-aligned times", (interval, timeMs) => {
    expect(() =>
      decodeWire("history", mutatedFixture("valid-history.json", (value) => {
        value.interval = interval;
        firstCandle(value).t = timeMs;
      })),
    ).not.toThrow();
  });

  it.each([
    ["1s", 1700000000000],
    ["1m", 1700000040000],
    ["5m", 1700000100000],
  ] as const)("accepts %s update candle batches with UTC-aligned times", (interval, timeMs) => {
    expect(() =>
      decodeWire("server", mutatedFixture("valid-server-update.json", (value) => {
        objectAt(value, "candles").interval = interval;
        firstUpdateCandle(value).t = timeMs;
      })),
    ).not.toThrow();
  });
});

describe("heartbeat candle head bounds", () => {
  it("rejects zero candle request id", () => {
    expect(() =>
      decodeWire("server", mutatedFixture("valid-server-heartbeat.json", (value) => {
        value.candleRequestId = 0;
        value.candleLatestRev = null;
      })),
    ).toThrow();
  });

  it("rejects zero candle latest revision", () => {
    expect(() =>
      decodeWire("server", mutatedFixture("valid-server-heartbeat.json", (value) => {
        value.candleRequestId = 1;
        value.candleLatestRev = 0;
      })),
    ).toThrow();
  });

  it("accepts positive candle request id with null latest revision", () => {
    expect(() =>
      decodeWire("server", mutatedFixture("valid-server-heartbeat.json", (value) => {
        value.candleRequestId = 1;
        value.candleLatestRev = null;
      })),
    ).not.toThrow();
  });
});

describe("debug action bounds", () => {
  it("rejects an unknown debug action", () => {
    expect(() =>
      decodeWire("client", mutatedFixture("valid-client-debug-pong-delay.json", (value) => {
        value.action = "resetAll";
        delete value.value;
      })),
    ).toThrow();
  });

  it.each([0, 4000])("accepts pongDelay bound %i", (value) => {
    expect(() =>
      decodeWire("client", mutatedFixture("valid-client-debug-pong-delay.json", (payload) => {
        payload.value = value;
      })),
    ).not.toThrow();
  });

  it("rejects pongDelay over the upper bound", () => {
    expect(() =>
      decodeWire("client", mutatedFixture("valid-client-debug-pong-delay.json", (value) => {
        value.value = 4001;
      })),
    ).toThrow();
  });
});

function mutatedFixture(file: string, mutate: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(readFixture(file)) as Record<string, unknown>;
  mutate(value);
  return JSON.stringify(value);
}

function objectAt(value: Record<string, unknown>, ...path: string[]): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function arrayAt(value: Record<string, unknown>, key: string): unknown[] {
  return value[key] as unknown[];
}

function firstCandle(value: Record<string, unknown>): Record<string, unknown> {
  return arrayAt(value, "candles")[0] as Record<string, unknown>;
}

function firstUpdateCandle(value: Record<string, unknown>): Record<string, unknown> {
  return ((objectAt(value, "candles").items as unknown[])[0]) as Record<string, unknown>;
}

function deletePath(value: Record<string, unknown>, path: string[]): void {
  let current = value;
  for (const key of path.slice(0, -1)) {
    current = current[key] as Record<string, unknown>;
  }
  delete current[path[path.length - 1]];
}
