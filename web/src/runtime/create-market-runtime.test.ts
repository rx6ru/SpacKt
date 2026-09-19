import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSocket, MarketRuntime, MarketRuntimeOptions } from "./types";

const fixtureRoot = join(process.cwd(), "..", "protocol", "fixtures");
const activeRuntimes: MarketRuntime[] = [];

type RuntimeFactory = (options: MarketRuntimeOptions) => MarketRuntime;

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
  resolve(response: Response): void;
  reject(error: unknown): void;
  promise: Promise<Response>;
};

function readFixture(file: string): string {
  return readFileSync(join(fixtureRoot, file), "utf8");
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fixtureResponse(file: string): Response {
  return new Response(readFixture(file), { status: 200, headers: { "content-type": "application/json" } });
}

function oversizedJsonResponse(cancel: () => void): Response {
  const encoder = new TextEncoder();
  const chunks = [readFixture("valid-meta.json"), ...Array.from({ length: 33 }, () => " ".repeat(65_536))];
  let index = 0;

  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
    cancel,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function cloneFixture(file: string): Record<string, unknown> {
  return JSON.parse(readFixture(file)) as Record<string, unknown>;
}

function ignoreMutationError(mutate: () => void): void {
  try {
    mutate();
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
  }
}

function encodeServerHeartbeat(value: { marketRev: number; bookSeq?: number; candleLatestRev?: number | null; feedReady?: boolean }): string {
  return encode({
    type: "heartbeat",
    session: "s1",
    marketRev: value.marketRev,
    bookSeq: value.bookSeq ?? 104,
    candleRequestId: 1,
    candleLatestRev: value.candleLatestRev ?? 84,
    feedReady: value.feedReady ?? true,
  });
}

function encode(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

async function loadFactory(): Promise<RuntimeFactory> {
  const mod = await import("./create-market-runtime") as { createMarketRuntime: RuntimeFactory };
  return mod.createMarketRuntime;
}

class FakeClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  set(now: number): void {
    this.current = now;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

class FakeScheduler {
  private nextId = 1;
  private timers = new Map<number, { at: number; delay: number; interval: boolean; callback: () => void }>();

  constructor(private readonly clock: FakeClock) {}

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.clock.now() + delayMs, delay: delayMs, interval: false, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  setInterval(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.clock.now() + delayMs, delay: delayMs, interval: true, callback });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  count(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.clock.now() + ms;
    while (true) {
      const due = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target);
      if (!due) break;
      const [id, timer] = due;
      this.clock.set(timer.at);
      if (!timer.interval) {
        this.timers.delete(id);
      }
      timer.callback();
      if (timer.interval && this.timers.has(id)) {
        this.timers.set(id, { ...timer, at: this.clock.now() + timer.delay });
      }
    }
    this.clock.set(target);
  }
}

class FakeSocket extends EventTarget implements RuntimeSocket {
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  closed = false;

  send(data: string): void {
    if (this.closed) throw new Error("send on closed fake socket");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new Error(`Browser cannot send close code ${code}`);
    }
    this.closed = true;
    this.closes.push({ code, reason });
  }

  open(): void {
    this.dispatchEvent(new Event("open"));
  }

  message(data: string): void {
    const event = new Event("message") as MessageEvent<string>;
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }

  closeFromServer(code: number, reason = ""): void {
    const event = new Event("close") as CloseEvent;
    Object.defineProperty(event, "code", { value: code });
    Object.defineProperty(event, "reason", { value: reason });
    Object.defineProperty(event, "wasClean", { value: false });
    this.dispatchEvent(event);
  }

  fail(): void {
    this.dispatchEvent(new Event("error"));
  }
}

class FakeWebSocketDriver {
  readonly sockets: FakeSocket[] = [];
  readonly urls: string[] = [];

  open(url: string): FakeSocket {
    const socket = new FakeSocket();
    this.urls.push(url);
    this.sockets.push(socket);
    return socket;
  }

  latest(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error("No fake socket has been opened");
    return socket;
  }
}

class FakeBrowser {
  readonly window = new EventTarget();
  readonly document = new EventTarget();
  hiddenValue = false;
  onlineValue = true;

  hidden(): boolean {
    return this.hiddenValue;
  }

  online(): boolean {
    return this.onlineValue;
  }

  setHidden(value: boolean): void {
    this.hiddenValue = value;
    this.document.dispatchEvent(new Event("visibilitychange"));
  }

  setOnline(value: boolean): void {
    this.onlineValue = value;
    this.window.dispatchEvent(new Event(value ? "online" : "offline"));
  }

  pagehide(): void {
    this.window.dispatchEvent(new Event("pagehide"));
  }

  pageshow(persisted = false): void {
    const event = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(event, "persisted", { value: persisted });
    this.window.dispatchEvent(event);
  }
}

function createControlledFetcher(): { fetcher: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    let resolve!: (response: Response) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (init?.signal?.aborted) {
      abort();
    } else {
      init?.signal?.addEventListener("abort", abort, { once: true });
    }
    calls.push({ url: String(input), init, resolve, reject, promise });
    return promise;
  }) as typeof fetch;

  return { fetcher, calls };
}

async function setup(startHidden = false, startOnline = true): Promise<{
  runtime: MarketRuntime;
  clock: FakeClock;
  scheduler: FakeScheduler;
  browser: FakeBrowser;
  webSocket: FakeWebSocketDriver;
  fetchCalls: FetchCall[];
}> {
  const createMarketRuntime = await loadFactory();
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const browser = new FakeBrowser();
  browser.hiddenValue = startHidden;
  browser.onlineValue = startOnline;
  const webSocket = new FakeWebSocketDriver();
  const { fetcher, calls } = createControlledFetcher();
  const runtime = createMarketRuntime({
    urls: {
      websocket: "wss://example.test/stream",
      meta: "https://example.test/meta",
      book: "https://example.test/book",
      trades: "https://example.test/trades",
      history: (interval, requestId) => `https://example.test/history?interval=${interval}&requestId=${requestId}`,
    },
    defaultInterval: "1s",
    protocolVersion: 1,
    fetcher,
    webSocket,
    clock,
    scheduler,
    browser,
    random: () => 0,
  });
  activeRuntimes.push(runtime);
  return { runtime, clock, scheduler, browser, webSocket, fetchCalls: calls };
}

function bootstrapSocket(runtime: MarketRuntime, webSocket: FakeWebSocketDriver): FakeSocket {
  runtime.start();
  expect(webSocket.urls).toEqual(["wss://example.test/stream"]);
  const socket = webSocket.latest();
  socket.open();
  socket.message(readFixture("valid-server-hello.json"));
  return socket;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushUntil(check: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await settle();
    if (check()) return;
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function callFor(calls: FetchCall[], text: string): FetchCall {
  const call = calls.find((candidate) => candidate.url.includes(text));
  if (!call) throw new Error(`No fetch call matched ${text}`);
  return call;
}

function latestCallFor(calls: FetchCall[], text: string): FetchCall {
  const call = calls.filter((candidate) => candidate.url.includes(text)).at(-1);
  if (!call) throw new Error(`No latest fetch call matched ${text}`);
  return call;
}

async function resolveBootstrap(runtime: MarketRuntime, calls: FetchCall[], latest = false): Promise<void> {
  const find = latest ? latestCallFor : callFor;
  find(calls, "/meta").resolve(fixtureResponse("valid-meta.json"));
  find(calls, "/book").resolve(fixtureResponse("valid-book.json"));
  find(calls, "/trades").resolve(fixtureResponse("valid-trades.json"));
  find(calls, "history?interval=1s").resolve(fixtureResponse("valid-history.json"));
  await flushUntil(() => {
    const snapshot = runtime.getSnapshot();
    return snapshot.meta.status === "ready"
      && snapshot.book.status === "synced"
      && snapshot.trades.status === "ready"
      && snapshot.candles.status === "ready";
  }, "bootstrap resources to become ready");
}

afterEach(() => {
  vi.useRealTimers();
  for (const runtime of activeRuntimes.splice(0)) {
    try {
      runtime.dispose();
    } catch (error) {
      if (!(error instanceof Error) || !/not implemented/i.test(error.message)) {
        throw error;
      }
    }
  }
});

describe("createMarketRuntime composition", () => {
  it("notifies subscribed listeners for committed state changes and stops after unsubscribe", async () => {
    const { runtime, webSocket } = await setup();
    let changed = 0;
    const unsubscribe = runtime.subscribe(() => {
      changed += 1;
    });

    runtime.start();
    webSocket.latest().open();
    webSocket.latest().message(readFixture("valid-server-hello.json"));
    expect(changed).toBeGreaterThan(0);

    const beforeUnsubscribe = changed;
    unsubscribe();
    webSocket.latest().message(readFixture("valid-server-tier.json"));
    expect(changed).toBe(beforeUnsubscribe);
  });

  it("returns the same snapshot object until a committed server event changes state", async () => {
    const { runtime, webSocket } = await setup();
    const initial = runtime.getSnapshot();

    expect(runtime.getSnapshot()).toBe(initial);

    runtime.start();
    const afterStart = runtime.getSnapshot();
    expect(afterStart).not.toBe(initial);
    expect(runtime.getSnapshot()).toBe(afterStart);

    const socket = webSocket.latest();
    socket.open();
    expect(runtime.getSnapshot()).toBe(afterStart);

    socket.message(readFixture("valid-server-hello.json"));
    const afterHello = runtime.getSnapshot();
    expect(afterHello).not.toBe(afterStart);
    expect(runtime.getSnapshot()).toBe(afterHello);

    socket.message(readFixture("valid-server-tier.json"));
    const afterTier = runtime.getSnapshot();
    expect(afterTier).not.toBe(afterHello);
    expect(runtime.getSnapshot()).toBe(afterTier);

    socket.message(encodeServerHeartbeat({ marketRev: 84, bookSeq: 104, candleLatestRev: 84 }));
    const afterHeartbeat = runtime.getSnapshot();
    expect(afterHeartbeat).not.toBe(afterTier);
    expect(runtime.getSnapshot()).toBe(afterHeartbeat);
  });

  it("opens one socket and starts metadata, trades, book, history, and subscription after hello", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    expect(fetchCalls.map((call) => call.url).sort()).toEqual([
      "https://example.test/book",
      "https://example.test/history?interval=1s&requestId=1",
      "https://example.test/meta",
      "https://example.test/trades",
    ]);
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "subscribe", session: "s1", interval: "1s", requestId: 1 });
    expect(runtime.getSnapshot()).toMatchObject({ session: "s1", symbol: "BTC-USD", selectedInterval: "1s" });
  });

  it("retries metadata when bootstrap fetch never finishes before the five-second deadline", async () => {
    vi.useFakeTimers();
    const { runtime, scheduler, webSocket, fetchCalls } = await setup();
    bootstrapSocket(runtime, webSocket);
    expect(fetchCalls.filter((call) => call.url.includes("/meta"))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushUntil(() => runtime.getSnapshot().meta.error !== null, "metadata deadline to record an error");
    scheduler.advance(500);
    await vi.advanceTimersByTimeAsync(500);
    await flushUntil(
      () => fetchCalls.filter((call) => call.url.includes("/meta")).length === 2 && runtime.getSnapshot().meta.attemptsUsed === 2,
      "metadata retry attempt two to be scheduled",
    );

    expect(runtime.getSnapshot().meta).toMatchObject({ status: "loading", attemptsUsed: 2 });
  });

  it("cancels an oversized metadata stream before buffering the whole response", async () => {
    const { runtime, scheduler, webSocket, fetchCalls } = await setup();
    const cancel = vi.fn();
    bootstrapSocket(runtime, webSocket);

    callFor(fetchCalls, "/meta").resolve(oversizedJsonResponse(cancel));

    await flushUntil(() => cancel.mock.calls.length === 1 && runtime.getSnapshot().meta.error !== null, "oversized metadata stream cancellation");
    scheduler.advance(500);
    await flushUntil(
      () => fetchCalls.filter((call) => call.url.includes("/meta")).length === 2 && runtime.getSnapshot().meta.attemptsUsed === 2,
      "oversized metadata retry attempt two to be scheduled",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().meta).toMatchObject({ status: "loading", attemptsUsed: 2 });
  });

  it("does not wait forever when no hello arrives after opening a visible socket", async () => {
    const { runtime, scheduler, webSocket } = await setup();

    runtime.start();
    const silentSocket = webSocket.latest();
    silentSocket.open();
    scheduler.advance(10_000);

    expect(silentSocket.closes.at(-1)?.code).toBe(1000);
    expect(webSocket.sockets).toHaveLength(2);
    expect(runtime.getSnapshot().diagnostics.lastError).toMatch(/hello|handshake|timeout/i);
  });

  it("maps REST wire data into the public domain snapshot cache", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    bootstrapSocket(runtime, webSocket);

    await resolveBootstrap(runtime, fetchCalls);

    const snapshot = runtime.getSnapshot();
    expect(snapshot).toMatchObject({
      meta: { status: "ready", value: { session: "s1", referencePriceTicks: 6_400_000 } },
      candles: { status: "ready", interval: "1s", requestId: 1, candles: [{ openTicks: 10000, rev: 84, closed: true }] },
      trades: { status: "ready", latestPriceTicks: 6_423_050, latestTradeId: 8 },
    });
    expect(snapshot.book.status).toBe("synced");
    expect(snapshot.book.bids).toHaveLength(10);
    expect(snapshot.book.bids[0]).toEqual({ priceTicks: 9900, quantityLots: 20000 });
  });

  it("keeps snapshots immutable and applies live trades to both latest fields and displayed list", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);

    const heldSnapshot = runtime.getSnapshot();
    const heldMeta = heldSnapshot.meta.value as { intervals: string[]; tierPolicy: { flushMs: { full: number } } };
    const heldTrades = heldSnapshot.trades.value as { trades: Array<{ id: number; priceTicks: number }> };
    ignoreMutationError(() => heldMeta.intervals.push("bad"));
    ignoreMutationError(() => { heldMeta.tierPolicy.flushMs.full = 999; });
    ignoreMutationError(() => { heldTrades.trades[0].priceTicks = 1; });
    ignoreMutationError(() => heldTrades.trades.push({ id: 99, priceTicks: 1 }));

    const nextSnapshot = runtime.getSnapshot();
    expect((nextSnapshot.meta.value as { intervals: string[]; tierPolicy: { flushMs: { full: number } } })).toMatchObject({
      intervals: ["1s", "1m", "5m"],
      tierPolicy: { flushMs: { full: 100 } },
    });
    expect((nextSnapshot.trades.value as { trades: Array<{ id: number; priceTicks: number }> }).trades).toEqual([
      expect.objectContaining({ id: 8, priceTicks: 6_423_050 }),
    ]);

    socket.message(encode({
      type: "update",
      session: "s1",
      marketRev: 85,
      trades: [{ id: 9, t: 1_700_000_000_900, p: "100.00", q: "1.0000", side: "buy" }],
      skipped: 0,
    }));

    const tradeSnapshot = runtime.getSnapshot();
    expect(tradeSnapshot.trades).toMatchObject({ latestTradeId: 9, latestPriceTicks: 10_000 });
    expect((tradeSnapshot.trades.value as { trades: Array<{ id: number; priceTicks: number }> }).trades[0]).toMatchObject({
      id: 9,
      priceTicks: 10_000,
    });
  });

  it("buffers an in-flight book range before the REST snapshot and applies it after the snapshot", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    socket.message(readFixture("valid-server-update.json"));
    expect(runtime.getSnapshot().book).toMatchObject({ status: "buffering", bufferedRanges: 1 });

    callFor(fetchCalls, "/book").resolve(fixtureResponse("valid-book.json"));
    await flushUntil(() => runtime.getSnapshot().book.status === "synced", "book snapshot and buffered range to sync");

    const snapshot = runtime.getSnapshot();
    expect(snapshot.book).toMatchObject({ status: "synced", expectedSeq: 105 });
    expect(snapshot.book.bids).toHaveLength(10);
    expect(snapshot.book.bids[0]).toEqual({ priceTicks: 9900, quantityLots: 10000 });
  });

  it("aborts stale A to B to A history requests and accepts only the current seed", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    bootstrapSocket(runtime, webSocket);
    const firstHistory = callFor(fetchCalls, "interval=1s&requestId=1");

    runtime.selectInterval("1m");
    const secondHistory = callFor(fetchCalls, "interval=1m&requestId=2");
    runtime.selectInterval("1s");
    const thirdHistory = callFor(fetchCalls, "interval=1s&requestId=3");

    expect((firstHistory.init?.signal as AbortSignal).aborted).toBe(true);
    expect((secondHistory.init?.signal as AbortSignal).aborted).toBe(true);

    firstHistory.resolve(fixtureResponse("valid-history.json"));
    secondHistory.resolve(fixtureResponse("valid-history.json"));
    thirdHistory.resolve(jsonResponse({
      session: "s1",
      symbol: "BTC-USD",
      interval: "1s",
      requestId: 3,
      candles: [],
    }));
    await flushUntil(() => runtime.getSnapshot().candles.status === "ready" && runtime.getSnapshot().candles.requestId === 3, "current A-B-A history seed to install");

    expect(runtime.getSnapshot().candles).toMatchObject({ status: "ready", interval: "1s", requestId: 3, candles: [] });
  });

  it("aborts bootstrap HTTP calls on same-session disconnect and resumes attempt two after delay", async () => {
    const { runtime, scheduler, webSocket, fetchCalls } = await setup();
    const firstSocket = bootstrapSocket(runtime, webSocket);
    const oldCalls = [...fetchCalls];
    expect(oldCalls).toHaveLength(4);

    firstSocket.closeFromServer(1006);

    expect(oldCalls.every((call) => (call.init?.signal as AbortSignal).aborted)).toBe(true);
    scheduler.advance(0);
    const secondSocket = webSocket.latest();
    secondSocket.open();
    secondSocket.message(readFixture("valid-server-hello.json"));

    for (const call of oldCalls) {
      call.resolve(fixtureResponse(
        call.url.includes("/meta") ? "valid-meta.json"
          : call.url.includes("/book") ? "valid-book.json"
            : call.url.includes("/trades") ? "valid-trades.json"
              : "valid-history.json",
      ));
    }
    await flushUntil(() => runtime.getSnapshot().meta.status === "loading" && runtime.getSnapshot().trades.status === "loading" && runtime.getSnapshot().candles.status === "loading", "old same-session responses to be ignored");

    expect(runtime.getSnapshot()).toMatchObject({
      meta: { status: "loading", attemptsUsed: 2 },
      trades: { status: "loading", attemptsUsed: 2 },
      candles: { status: "loading", attemptsUsed: 2 },
    });
    expect(runtime.getSnapshot().book.status).not.toBe("synced");
    expect(runtime.getSnapshot().book.bids).toEqual([]);
    expect(fetchCalls).toHaveLength(4);

    scheduler.advance(499);
    expect(fetchCalls).toHaveLength(4);
    scheduler.advance(1);
    expect(fetchCalls).toHaveLength(8);
  });

  it("resets session engines for a new session but preserves same-session continuity", async () => {
    const { runtime, scheduler, webSocket, fetchCalls } = await setup();
    const first = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);
    expect(runtime.getSnapshot().trades.latestTradeId).toBe(8);

    first.closeFromServer(1006);
    scheduler.advance(0);
    const second = webSocket.latest();
    second.open();
    second.message(encode({ ...JSON.parse(readFixture("valid-server-hello.json")), connId: "c2" }));
    expect(runtime.getSnapshot().trades.latestTradeId).toBe(8);

    second.closeFromServer(1006);
    scheduler.advance(0);
    const third = webSocket.latest();
    third.open();
    third.message(encode({ ...JSON.parse(readFixture("valid-server-hello.json")), session: "s2", connId: "c3" }));
    expect(runtime.getSnapshot()).toMatchObject({ session: "s2", book: { bids: [] }, candles: { candles: [] }, trades: { latestTradeId: null } });
  });

  it("ignores old socket callbacks after a newer socket epoch opens", async () => {
    const { runtime, scheduler, webSocket } = await setup();
    runtime.start();
    const oldSocket = webSocket.latest();
    oldSocket.open();
    oldSocket.closeFromServer(1006);
    scheduler.advance(0);
    const currentSocket = webSocket.latest();
    currentSocket.open();
    currentSocket.message(readFixture("valid-server-hello.json"));

    const beforeOldCallbacks = runtime.getSnapshot();
    const currentSentCount = currentSocket.sent.length;

    oldSocket.message(readFixture("valid-server-update.json"));
    oldSocket.closeFromServer(4002, "unsupported");

    expect(currentSocket.sent).toHaveLength(currentSentCount);
    expect(runtime.getSnapshot()).toMatchObject({
      session: beforeOldCallbacks.session,
      reloadRequired: beforeOldCallbacks.reloadRequired,
      connection: { status: beforeOldCallbacks.connection.status, terminalReason: beforeOldCallbacks.connection.terminalReason },
      book: { bids: beforeOldCallbacks.book.bids, asks: beforeOldCallbacks.book.asks },
      candles: { candles: beforeOldCallbacks.candles.candles },
      trades: { latestTradeId: beforeOldCallbacks.trades.latestTradeId },
    });
  });

  it("marks metadata failed after five mismatched-session attempts", async () => {
    const { runtime, scheduler, webSocket, fetchCalls } = await setup();
    bootstrapSocket(runtime, webSocket);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      latestCallFor(fetchCalls, "/meta").resolve(jsonResponse({ ...cloneFixture("valid-meta.json"), session: "other" }));
      if (attempt < 4) {
        await flushUntil(() => runtime.getSnapshot().meta.error !== null && runtime.getSnapshot().meta.attemptsUsed === attempt + 2, `metadata scheduled attempt ${attempt + 2}`);
        scheduler.advance([500, 1000, 2000, 4000][attempt]);
        await flushUntil(() => fetchCalls.filter((call) => call.url.includes("/meta")).length === attempt + 2, `metadata retry HTTP ${attempt + 2}`);
      } else {
        await flushUntil(() => runtime.getSnapshot().meta.status === "failed" && runtime.getSnapshot().manualRetryRequired, "metadata owner to fail after five attempts");
      }
    }

    expect(runtime.getSnapshot()).toMatchObject({
      manualRetryRequired: true,
      meta: { status: "failed", attemptsUsed: 5 },
      diagnostics: { requestErrors: { meta: expect.stringMatching(/session/i) } },
    });
  });

  it("reconnects on wrong-session market data without installing that data", async () => {
    const { runtime, scheduler, webSocket } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    socket.message(encode({ ...JSON.parse(readFixture("valid-server-update.json")), session: "other" }));
    scheduler.advance(0);

    expect(webSocket.sockets).toHaveLength(2);
    expect(runtime.getSnapshot()).toMatchObject({ session: "s1", book: { bids: [] } });
  });

  it("counts malformed current-epoch messages without advancing market state", async () => {
    const { runtime, webSocket } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    socket.message("{");

    expect(runtime.getSnapshot()).toMatchObject({
      diagnostics: { malformedMessages: 1 },
      book: { bids: [] },
      observedRate: { sampleCount: 0 },
    });
  });

  it("closes once with 4002 for unsupported hello version and ignores later messages", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    runtime.start();
    const socket = webSocket.latest();
    socket.open();
    socket.message(encode({ ...cloneFixture("valid-server-hello.json"), v: 2 }));
    const terminalSnapshot = runtime.getSnapshot();

    socket.message(readFixture("valid-server-hello.json"));
    socket.message(readFixture("valid-server-update.json"));

    expect(socket.closes).toEqual([{ code: 4002, reason: expect.any(String) }]);
    expect(fetchCalls).toHaveLength(0);
    expect(runtime.getSnapshot()).toEqual(terminalSnapshot);
  });

  it("stops probes while hidden and resumes them without sending browser-forbidden close codes", async () => {
    const { runtime, scheduler, browser, webSocket } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    scheduler.advance(1000);
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "ping", session: "s1", id: 1 });

    browser.setHidden(true);
    scheduler.advance(5000);
    expect(socket.closes.every((close) => close.code === undefined || close.code === 1000 || (close.code >= 3000 && close.code <= 4999))).toBe(true);
    expect(socket.sent.filter((value) => JSON.parse(value).type === "ping")).toHaveLength(1);

    browser.setHidden(false);
    expect(socket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "ping")).toEqual([
      { type: "ping", session: "s1", id: 1 },
      { type: "ping", session: "s1", id: 2 },
    ]);
    scheduler.advance(1000);
    expect(socket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "ping")).toEqual([
      { type: "ping", session: "s1", id: 1 },
      { type: "ping", session: "s1", id: 2 },
      { type: "ping", session: "s1", id: 3 },
    ]);
  });

  it("preserves request-owner budgets when same-session cleanup aborts in-flight bootstrap", async () => {
    const { runtime, scheduler, browser, webSocket, fetchCalls } = await setup();
    bootstrapSocket(runtime, webSocket);
    callFor(fetchCalls, "/meta").resolve(jsonResponse({ ...cloneFixture("valid-meta.json"), session: "other" }));
    await flushUntil(() => runtime.getSnapshot().meta.error !== null && runtime.getSnapshot().meta.attemptsUsed === 2, "metadata failure to schedule attempt two");
    scheduler.advance(500);
    await flushUntil(() => fetchCalls.filter((call) => call.url.includes("/meta")).length === 2, "metadata retry attempt two HTTP request");
    const retry = latestCallFor(fetchCalls, "/meta");

    browser.setOnline(false);

    expect((retry.init?.signal as AbortSignal).aborted).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({
      meta: { attemptsUsed: 2 },
      diagnostics: { requestErrors: { meta: expect.stringMatching(/session/i) } },
    });
  });

  it("closes and aborts while offline, then opens a fresh socket when online", async () => {
    const { runtime, scheduler, browser, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    browser.setOnline(false);

    expect(socket.closes.at(-1)?.code).toBe(1000);
    expect(fetchCalls.every((call) => (call.init?.signal as AbortSignal).aborted)).toBe(true);
    expect(runtime.getSnapshot().connection.status).toBe("offline");

    browser.setOnline(true);
    scheduler.advance(0);
    expect(webSocket.sockets).toHaveLength(2);
  });

  it("pagehide closes with code 1000 and persisted pageshow opens a fresh epoch", async () => {
    const { runtime, scheduler, browser, webSocket } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    const beforeEpoch = runtime.getSnapshot().epoch;

    browser.pagehide();
    expect(socket.closes.at(-1)?.code).toBe(1000);

    browser.pageshow(true);
    scheduler.advance(0);
    expect(webSocket.sockets).toHaveLength(2);
    expect(runtime.getSnapshot().epoch).toBeGreaterThan(beforeEpoch);
  });

  it("dispose closes sockets, aborts requests, cancels timers, removes listeners, and freezes later callbacks", async () => {
    const { runtime, browser, scheduler, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    runtime.dispose();
    const disposedSnapshot = runtime.getSnapshot();

    expect(socket.closes.at(-1)?.code).toBe(1000);
    expect(fetchCalls.every((call) => (call.init?.signal as AbortSignal).aborted)).toBe(true);
    expect(scheduler.count()).toBe(0);

    socket.message(readFixture("valid-server-update.json"));
    browser.setOnline(false);
    browser.setHidden(true);

    expect(runtime.getSnapshot()).toEqual(disposedSnapshot);
  });

  it("keeps cachedStale true after 4009 until all fresh bootstrap resources complete", async () => {
    const { runtime, webSocket, fetchCalls, scheduler } = await setup();
    const first = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);

    first.closeFromServer(4009, "fresh state required");
    expect(runtime.getSnapshot().cachedStale).toBe(true);
    scheduler.advance(10_000);
    const fresh = webSocket.latest();
    fresh.open();
    fresh.message(readFixture("valid-server-hello.json"));
    expect(runtime.getSnapshot().cachedStale).toBe(true);

    await resolveBootstrap(runtime, fetchCalls, true);
    expect(runtime.getSnapshot().cachedStale).toBe(false);
  });

  it("does not open a socket before the hidden 4008 cooldown expires on visible return", async () => {
    const { runtime, browser, scheduler, webSocket } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    browser.setHidden(true);
    socket.closeFromServer(4008, "rate limited");
    browser.setHidden(false);

    expect(webSocket.sockets).toHaveLength(1);
    scheduler.advance(9_999);
    expect(webSocket.sockets).toHaveLength(1);

    scheduler.advance(1);
    expect(webSocket.sockets).toHaveLength(2);
    expect(runtime.getSnapshot().connection.status).toBe("connecting");
  });

  it("does not let visible return or manual retry bypass the hidden 4009 cooldown", async () => {
    const { runtime, browser, scheduler, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);

    browser.setHidden(true);
    socket.closeFromServer(4009, "payload too large");
    scheduler.advance(8_000);
    browser.setHidden(false);
    runtime.retry();

    expect(runtime.getSnapshot().cachedStale).toBe(true);
    expect(webSocket.sockets).toHaveLength(1);
    scheduler.advance(1_999);
    expect(webSocket.sockets).toHaveLength(1);

    scheduler.advance(1);
    expect(webSocket.sockets).toHaveLength(2);
  });

  it("opens on visible return when the hidden 4009 cooldown already elapsed", async () => {
    const { runtime, browser, scheduler, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);

    browser.setHidden(true);
    socket.closeFromServer(4009, "payload too large");
    scheduler.advance(10_000);
    browser.setHidden(false);

    expect(webSocket.sockets).toHaveLength(2);
    expect(runtime.getSnapshot().cachedStale).toBe(true);
  });

  it("keeps the cooldown through hidden offline online return", async () => {
    const { runtime, browser, scheduler, webSocket } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    browser.setHidden(true);
    socket.closeFromServer(4008, "rate limited");
    browser.setOnline(false);
    browser.setHidden(false);
    browser.setOnline(true);

    expect(webSocket.sockets).toHaveLength(1);
    scheduler.advance(9_999);
    expect(webSocket.sockets).toHaveLength(1);

    scheduler.advance(1);
    expect(webSocket.sockets).toHaveLength(2);
  });

  it("sets liveEligible only after metadata, book, trades, current history, and feed readiness are live", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);

    expect(runtime.getSnapshot().liveEligible).toBe(false);

    socket.message(encode({
      type: "heartbeat",
      session: "s1",
      marketRev: 84,
      bookSeq: 104,
      candleRequestId: 1,
      candleLatestRev: 84,
      feedReady: true,
    }));

    expect(runtime.getSnapshot()).toMatchObject({
      liveEligible: true,
      freshness: { condition: "live", lastMarketRev: 84 },
    });
  });

  it("resyncs local book and candle heads when heartbeats keep advertising newer data without payloads", async () => {
    const { runtime, scheduler, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);
    const callsBeforeStall = fetchCalls.length;

    for (let second = 1; second <= 7; second += 1) {
      scheduler.advance(1_000);
      socket.message(encodeServerHeartbeat({ marketRev: 84 + second, bookSeq: 102 + second, candleLatestRev: 84 + second }));
    }

    expect(fetchCalls.length).toBeGreaterThan(callsBeforeStall);
    expect(fetchCalls.some((call, index) => index >= callsBeforeStall && call.url.includes("/book"))).toBe(true);
    expect(fetchCalls.some((call, index) => index >= callsBeforeStall && call.url.includes("history?interval=1s"))).toBe(true);
  });

  it("marks ready cached data stale and not live-eligible after an ordinary disconnect", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);
    socket.message(encodeServerHeartbeat({ marketRev: 84, bookSeq: 102, candleLatestRev: 84 }));
    expect(runtime.getSnapshot().liveEligible).toBe(true);

    socket.closeFromServer(1006);

    expect(runtime.getSnapshot()).toMatchObject({
      cachedStale: true,
      liveEligible: false,
    });
  });

  it("retries wrong-request current history and does not mark history ready from the stale response", async () => {
    const { runtime, scheduler, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    callFor(fetchCalls, "/meta").resolve(fixtureResponse("valid-meta.json"));
    callFor(fetchCalls, "/book").resolve(fixtureResponse("valid-book.json"));
    callFor(fetchCalls, "/trades").resolve(fixtureResponse("valid-trades.json"));
    socket.message(readFixture("valid-server-update.json"));
    callFor(fetchCalls, "history?interval=1s&requestId=1").resolve(jsonResponse({
      ...cloneFixture("valid-history.json"),
      requestId: 2,
    }));
    await flushUntil(() => runtime.getSnapshot().candles.error !== null && runtime.getSnapshot().candles.attemptsUsed === 2, "wrong history request id rejection and retry scheduling");

    expect(runtime.getSnapshot().candles).toMatchObject({ status: "loading", requestId: 1, attemptsUsed: 2 });
    scheduler.advance(500);
    const firstHistory = callFor(fetchCalls, "history?interval=1s&requestId=1");
    await flushUntil(() => fetchCalls.some((call) => call.url.includes("history?interval=1s&requestId=1") && call !== firstHistory), "history retry for current request id");
    expect(runtime.getSnapshot().candles.status).not.toBe("ready");
  });

  it("spends shared history budget and renews same-socket request IDs for repeated candle resets", async () => {
    const { runtime, scheduler, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);

    socket.message(readFixture("valid-server-candles-reset.json"));
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "subscribe", session: "s1", interval: "1s", requestId: 2 });
    expect(fetchCalls.some((call) => call.url.includes("history?interval=1s&requestId=2"))).toBe(true);

    socket.message(encode({ ...cloneFixture("valid-server-candles-reset.json"), requestId: 2 }));
    scheduler.advance(500);

    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "subscribe", session: "s1", interval: "1s", requestId: 3 });
    expect(fetchCalls.some((call) => call.url.includes("history?interval=1s&requestId=3"))).toBe(true);
    expect(runtime.getSnapshot().candles.attemptsUsed).toBe(2);
  });

  it("renews same-socket request ID and spends history budget after an equal-revision candle conflict", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    await resolveBootstrap(runtime, fetchCalls);

    socket.message(encode({
      type: "update",
      session: "s1",
      marketRev: 85,
      candles: {
        requestId: 1,
        interval: "1s",
        items: [{ t: 1_700_000_000_000, o: "100.00", h: "104.00", l: "99.00", c: "101.00", v: "1.0000", rev: 84, closed: true }],
      },
    }));

    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "subscribe", session: "s1", interval: "1s", requestId: 2 });
    expect(fetchCalls.some((call) => call.url.includes("history?interval=1s&requestId=2"))).toBe(true);
    expect(runtime.getSnapshot().candles.attemptsUsed).toBe(1);
  });

  it("clears the manual retry gate after retry succeeds for a failed resource", async () => {
    const { runtime, scheduler, webSocket, fetchCalls } = await setup();
    bootstrapSocket(runtime, webSocket);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      latestCallFor(fetchCalls, "/meta").resolve(jsonResponse({ ...cloneFixture("valid-meta.json"), session: "other" }));
      if (attempt < 4) {
        await flushUntil(() => runtime.getSnapshot().meta.error !== null && runtime.getSnapshot().meta.attemptsUsed === attempt + 2, `metadata scheduled attempt ${attempt + 2}`);
        scheduler.advance([500, 1000, 2000, 4000][attempt]);
        await flushUntil(() => fetchCalls.filter((call) => call.url.includes("/meta")).length === attempt + 2, `metadata retry HTTP ${attempt + 2}`);
      } else {
        await flushUntil(() => runtime.getSnapshot().manualRetryRequired, "manual retry gate after metadata failure");
      }
    }

    runtime.retry();
    latestCallFor(fetchCalls, "/meta").resolve(fixtureResponse("valid-meta.json"));
    await flushUntil(() => runtime.getSnapshot().meta.status === "ready", "metadata retry success");

    expect(runtime.getSnapshot()).toMatchObject({ manualRetryRequired: false, meta: { status: "ready", attemptsUsed: 0 } });
  });

  it("does not start extra sockets or HTTP requests when retry is invoked while hidden or offline", async () => {
    const hidden = await setup(true, true);
    hidden.runtime.start();
    const hiddenSockets = hidden.webSocket.sockets.length;
    const hiddenFetches = hidden.fetchCalls.length;
    hidden.runtime.retry();
    expect(hidden.webSocket.sockets).toHaveLength(hiddenSockets);
    expect(hidden.fetchCalls).toHaveLength(hiddenFetches);

    const offline = await setup(false, false);
    offline.runtime.start();
    const offlineSockets = offline.webSocket.sockets.length;
    const offlineFetches = offline.fetchCalls.length;
    offline.runtime.retry();
    expect(offline.webSocket.sockets).toHaveLength(offlineSockets);
    expect(offline.fetchCalls).toHaveLength(offlineFetches);
  });

  it("retains the pong for the immediate visible-return probe", async () => {
    const { runtime, scheduler, browser, webSocket } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);
    scheduler.advance(1_000);
    scheduler.advance(120);
    socket.message(encode({ type: "pong", session: "s1", id: 1 }));
    browser.setHidden(true);

    browser.setHidden(false);
    const immediatePing = socket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "ping").at(-1);
    expect(immediatePing).toEqual({ type: "ping", session: "s1", id: 2 });
    scheduler.advance(80);
    socket.message(encode({ type: "pong", session: "s1", id: 2 }));

    expect(runtime.getSnapshot().telemetry.successes).toContainEqual(expect.objectContaining({ id: 2, rttMs: 80 }));
  });

  it("uses one monotonic clock for pongs and sends reports only after enough RTT samples", async () => {
    const { runtime, scheduler, webSocket } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    scheduler.advance(1000);
    scheduler.advance(120);
    socket.message(encode({ type: "pong", session: "s1", id: 1 }));
    scheduler.advance(880);
    expect(socket.sent.map((value) => JSON.parse(value)).some((value) => value.type === "report")).toBe(false);

    scheduler.advance(140);
    socket.message(encode({ type: "pong", session: "s1", id: 2 }));
    scheduler.advance(1860);

    const reports = socket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "report");
    expect(reports).toContainEqual(expect.objectContaining({ type: "report", session: "s1", samples: 2, latencyMs: 130 }));
  });

  it("sends debug controls only for the server-owned live session", async () => {
    const { runtime, webSocket } = await setup();

    runtime.debug({ action: "dropNextBookDelta" });
    expect(webSocket.sockets).toHaveLength(0);
    expect(runtime.getSnapshot().diagnostics.lastError).toMatch(/debug/i);

    const socket = bootstrapSocket(runtime, webSocket);
    runtime.debug({ action: "forceTier", value: "minimal" });

    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "debug", session: "s1", action: "forceTier", value: "minimal" });
  });
});
