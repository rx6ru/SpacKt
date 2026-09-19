import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWire } from "./http";

const validHealth = { status: "ok" };
const validMeta = {
  session: "s1",
  symbol: "BTC-USD",
  tickSize: "0.01",
  lotSize: "0.0001",
  intervals: ["1s", "1m", "5m"],
  referencePrice: "64000.00",
  tierPolicy: {
    initialTier: "degraded",
    flushMs: { full: 100, degraded: 500, minimal: 2000 },
    enterDegraded: { latencyAboveMs: 400, jitterAboveMs: 60 },
    enterMinimal: { latencyAboveMs: 900, jitterAboveMs: 150 },
    recoverFull: { latencyBelowMs: 300, jitterBelowMs: 40 },
    recoverDegraded: { latencyBelowMs: 700, jitterBelowMs: 100 },
    downgradeDwellMs: 3000,
    upgradeDwellMs: 10000,
    missingReportStepMs: 5000,
    missingReportMinimalMs: 12000,
    pingEveryMs: 1000,
    pongTimeoutMs: 3000,
    reportEveryMs: 2000,
    rttWindowSamples: 10,
    minimumReportSamples: 2,
    hiddenCloseMs: 180000,
  },
  retention: {
    historyCandles: { "1s": 3600, "1m": 1440, "5m": 2016 },
    deliveryClosedCandles: 64,
    recentTrades: 200,
    bookChanges: 4096,
    maximumBookLevelsPerSide: 50,
  },
};
const validBook = {
  session: "s1",
  symbol: "BTC-USD",
  seq: 102,
  t: 1700000000100,
  bids: [
    ["99.00", "2.0000"],
    ["98.99", "1.0000"],
    ["98.98", "1.0000"],
    ["98.97", "1.0000"],
    ["98.96", "1.0000"],
    ["98.95", "1.0000"],
    ["98.94", "1.0000"],
    ["98.93", "1.0000"],
    ["98.92", "1.0000"],
    ["98.91", "1.0000"],
  ],
  asks: [
    ["101.00", "3.0000"],
    ["101.01", "1.0000"],
    ["101.02", "1.0000"],
    ["101.03", "1.0000"],
    ["101.04", "1.0000"],
    ["101.05", "1.0000"],
    ["101.06", "1.0000"],
    ["101.07", "1.0000"],
    ["101.08", "1.0000"],
    ["101.09", "1.0000"],
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchWire success path", () => {
  it("fetches and decodes process health", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(validHealth));

    await expect(fetchWire("health", "/healthz", { fetcher })).resolves.toEqual(validHealth);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fetches and decodes metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(validMeta));

    await expect(fetchWire("meta", "/api/meta", { fetcher })).resolves.toEqual(validMeta);
  });

  it("fetches and decodes a book snapshot", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(validBook));

    await expect(fetchWire("book", "/api/book", { fetcher })).resolves.toEqual(validBook);
  });

  it("omits credentials and sends only an Accept header", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(validHealth));

    await fetchWire("health", "/healthz", { fetcher });

    const [, init] = fetcher.mock.calls[0] ?? [];
    expect([undefined, "GET"]).toContain(init?.method);
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBe("omit");
    expect(headerValue(init?.headers, "accept")).toBe("application/json");
    expect(headerValue(init?.headers, "content-type")).toBeUndefined();
  });
});

describe("fetchWire rejection path", () => {
  it("rejects non-2xx HTTP responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { code: "not_ready", message: "Not ready." } }, { status: 503 }),
    );

    await expect(fetchWire("health", "/healthz", { fetcher })).rejects.toThrow(/503|not_ready|http/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry transport failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Network down"));

    await expect(fetchWire("health", "/healthz", { fetcher })).rejects.toThrow(/network down/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(textResponse("{bad json"));

    await expect(fetchWire("health", "/healthz", { fetcher })).rejects.toThrow(/json/i);
  });

  it("rejects JSON that does not match the requested wire schema", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ready" }));

    await expect(fetchWire("health", "/healthz", { fetcher })).rejects.toThrow(/schema|health|status/i);
  });

  it("rejects a body whose actual stream bytes exceed the limit despite a smaller Content-Length", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      textResponse("12345", { headers: { "Content-Length": "1" } }),
    );

    await expect(fetchWire("health", "/healthz", { fetcher, maxBytes: 4 })).rejects.toThrow(/bytes|size|large/i);
  });

  it("counts multibyte UTF-8 bytes before JSON parsing", async () => {
    const body = `${JSON.stringify(validHealth)}é`;
    const byteLength = new TextEncoder().encode(body).byteLength;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(textResponse(body));

    await expect(fetchWire("health", "/healthz", { fetcher, maxBytes: byteLength - 1 })).rejects.toThrow(
      /bytes|size|large/i,
    );
  });

  it("uses the default two MiB byte cap before decoding", async () => {
    const validPrefix = JSON.stringify(validHealth);
    const body = `${validPrefix}${" ".repeat(2 * 1024 * 1024 + 1 - new TextEncoder().encode(validPrefix).byteLength)}`;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(textResponse(body));

    await expect(fetchWire("health", "/healthz", { fetcher })).rejects.toThrow(/bytes|size|large|2 mib/i);
  });
});

describe("fetchWire deadline and abort behavior", () => {
  it("uses the default five second deadline when fetch never settles", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => {}));
    const settled = fetchWire("health", "/healthz", { fetcher }).then(
      () => ({ status: "resolved" as const, error: null }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await vi.advanceTimersByTimeAsync(5_000);

    const outcome = await settled;
    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toMatch(/timeout|deadline|abort/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects when the body stalls past the total deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(delayedStream(6_000, "{}")));
    const settled = fetchWire("health", "/healthz", { fetcher, timeoutMs: 5_000 }).then(
      () => ({ status: "resolved" as const, error: null }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await vi.advanceTimersByTimeAsync(5_000);

    const outcome = await settled;
    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toMatch(/timeout|deadline|abort/i);
  });

  it("uses a five second body deadline by default", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(delayedStream(6_000, "{}")));
    const settled = fetchWire("health", "/healthz", { fetcher }).then(
      () => ({ status: "resolved" as const, error: null }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await vi.advanceTimersByTimeAsync(5_000);

    const outcome = await settled;
    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toMatch(/timeout|deadline|abort/i);
  });

  it("uses the parent abort instead of waiting for the helper timeout", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const listenerCounts = countAbortListeners(parent.signal);
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")));
      });
    });
    const result = fetchWire("health", "/healthz", { fetcher, signal: parent.signal, timeoutMs: 5_000 });

    parent.abort(new DOMException("Parent abort", "AbortError"));
    await expect(result).rejects.toThrow(/parent abort|abort/i);
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerCounts.added).toBe(listenerCounts.removed);
  });

  it("cancels an active body reader when the parent signal aborts", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));

    const result = fetchWire("health", "/healthz", { fetcher, signal: parent.signal, timeoutMs: 5_000 });
    parent.abort(new DOMException("Parent abort", "AbortError"));

    await expect(result).rejects.toThrow(/parent abort|abort/i);
    expect(cancelled).toBe(true);
  });

  it("cleans up timeout handles and parent abort listeners after success", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const listenerCounts = countAbortListeners(parent.signal);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(validHealth));

    await expect(fetchWire("health", "/healthz", { fetcher, signal: parent.signal })).resolves.toEqual(validHealth);

    expect(vi.getTimerCount()).toBe(0);
    expect(listenerCounts.added).toBe(listenerCounts.removed);
  });
});

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return textResponse(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function textResponse(body: string, init: ResponseInit = {}) {
  return new Response(streamFromText(body), init);
}

function streamFromText(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function delayedStream(delayMs: number, text: string) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(bytes);
        controller.close();
      }, delayMs);
    },
  });
}

function headerValue(headers: HeadersInit | undefined, name: string) {
  if (!headers) return undefined;
  return new Headers(headers).get(name) ?? undefined;
}

function countAbortListeners(signal: AbortSignal) {
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  const counts = { added: 0, removed: 0 };
  vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "abort") counts.added += 1;
    return originalAdd(type, listener, options);
  });
  vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "abort") counts.removed += 1;
    return originalRemove(type, listener, options);
  });
  return counts;
}
