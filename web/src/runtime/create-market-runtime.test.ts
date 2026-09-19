import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
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

  it("buffers an in-flight book range before the REST snapshot and applies it after the snapshot", async () => {
    const { runtime, webSocket, fetchCalls } = await setup();
    const socket = bootstrapSocket(runtime, webSocket);

    socket.message(readFixture("valid-server-update.json"));
    expect(runtime.getSnapshot().book).toMatchObject({ status: "buffering", bufferedRanges: 1 });

    callFor(fetchCalls, "/book").resolve(fixtureResponse("valid-book.json"));
    await settle();

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
    await settle();

    expect(runtime.getSnapshot().candles).toMatchObject({ status: "ready", interval: "1s", requestId: 3, candles: [] });
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
      const call = fetchCalls.filter((candidate) => candidate.url.includes("/meta")).at(-1);
      if (!call) throw new Error("missing metadata fetch");
      call.resolve(jsonResponse({ ...JSON.parse(readFixture("valid-meta.json")), session: "other" }));
      await settle();
      if (attempt < 4) {
        scheduler.advance([500, 1000, 2000, 4000][attempt]);
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

  it("enters terminal reload-required state for unsupported hello version", async () => {
    const { runtime, webSocket } = await setup();
    runtime.start();
    const socket = webSocket.latest();
    socket.open();
    socket.message(encode({ ...JSON.parse(readFixture("valid-server-hello.json")), v: 2 }));

    expect(runtime.getSnapshot()).toMatchObject({
      reloadRequired: true,
      connection: { status: "terminal", terminalReason: "protocol_mismatch" },
      book: { bids: [] },
    });
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
    callFor(fetchCalls, "/meta").resolve(jsonResponse({ ...JSON.parse(readFixture("valid-meta.json")), session: "other" }));
    await flushUntil(() => runtime.getSnapshot().meta.attemptsUsed === 1, "first metadata failure to spend one attempt");
    scheduler.advance(500);
    const retry = latestCallFor(fetchCalls, "/meta");

    browser.setOnline(false);

    expect((retry.init?.signal as AbortSignal).aborted).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({
      meta: { attemptsUsed: 1 },
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
