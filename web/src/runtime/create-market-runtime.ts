import type { DebugCommand, HistoryDomain, Meta, RecentTradesDomain, ServerEvent } from "../domain/events";
import type { MarketRuntimeSnapshot, TierView } from "../domain/market-view";
import type { Interval } from "../domain/model";
import { BookSync, type BookSyncEffects } from "../engines/book-sync";
import { CandleFeed, type CandleFeedEffects } from "../engines/candle-feed";
import { FreshnessMonitor, type FreshnessEffects } from "../engines/freshness";
import { ObservedRate } from "../engines/observed-rate";
import { RecentTrades } from "../engines/recent-trades";
import { Telemetry } from "../engines/telemetry";
import { ConnectionLifecycle, type LifecycleEffects } from "../net/lifecycle";
import { RequestOwner, type RequestTask } from "../net/request-owner";
import {
  decodeRuntimeServerEvent, encodeClientWire, fetchRuntimeWire,
  mapRuntimeBook, mapRuntimeHistory, mapRuntimeMeta, mapRuntimeTrades, ProtocolVersionError,
} from "../net/runtime-wire";
import type { MarketRuntime, MarketRuntimeOptions, RuntimeSocket } from "./types";

export type { MarketRuntime, MarketRuntimeOptions } from "./types";
export type { MarketRuntimeSnapshot } from "../domain/market-view";

type Connection = {
  socket: RuntimeSocket;
  epoch: number;
  listeners: Record<"open" | "message" | "close" | "error", EventListener>;
};
type Timer = "helloTimer" | "reconnectTimer" | "bookTimer" | "pingTimer" | "reportTimer" | "healthTimer";

export function createMarketRuntime(options: MarketRuntimeOptions): MarketRuntime {
  return new Runtime(options);
}

class Runtime implements MarketRuntime {
  private readonly lifecycle: ConnectionLifecycle;
  private readonly book = new BookSync();
  private readonly candles = new CandleFeed();
  private readonly trades = new RecentTrades();
  private readonly telemetry = new Telemetry();
  private readonly freshness: FreshnessMonitor;
  private readonly rate: ObservedRate;
  private readonly metaOwner: RequestOwner<Meta>;
  private readonly tradesOwner: RequestOwner<RecentTradesDomain>;
  private readonly historyOwner: RequestOwner<HistoryDomain>;
  private readonly subscribers = new Set<() => void>();
  private readonly browserListeners: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];
  private published: MarketRuntimeSnapshot;
  private connection: Connection | null = null;
  private selectedInterval: Interval;
  private meta: Meta | null = null;
  private tier: TierView = { effective: null, auto: null, forced: null, hidden: false, flushMs: null, reason: null };
  private helloReceived = false;
  private started = false;
  private disposed = false;
  private batchDepth = 0;
  private requestId = 0;
  private pingId = 0;
  private feedReady = false;
  private cachedStale = false;
  private manualBootstrap = false;
  private skipped = 0;
  private malformedMessages = 0;
  private lastError: string | null = null;
  private lastMessageErrorAt = -Infinity;
  private bookError: string | null = null;
  private bookController: AbortController | null = null;
  private helloTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private bookTimer: unknown = null;
  private pingTimer: unknown = null;
  private reportTimer: unknown = null;
  private healthTimer: unknown = null;

  constructor(private readonly options: MarketRuntimeOptions) {
    this.selectedInterval = options.defaultInterval;
    this.published = freeze(createInitialSnapshot(options.defaultInterval));
    this.lifecycle = new ConnectionLifecycle({ now: () => this.now(), random: options.random, protocolVersion: options.protocolVersion });
    this.freshness = new FreshnessMonitor({ now: () => this.now() });
    this.rate = new ObservedRate(this.now());
    const ownerOptions = { scheduler: options.scheduler, onChange: () => this.publish() };
    this.metaOwner = new RequestOwner(ownerOptions);
    this.tradesOwner = new RequestOwner(ownerOptions);
    this.historyOwner = new RequestOwner(ownerOptions);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.change(() => {
      this.listen(this.options.browser.document, "visibilitychange", () => this.visibilityChanged());
      this.listen(this.options.browser.window, "offline", () => this.applyLifecycle(this.lifecycle.onlineChanged(false)));
      this.listen(this.options.browser.window, "online", () => this.applyLifecycle(this.lifecycle.onlineChanged(true)));
      this.listen(this.options.browser.window, "pagehide", (event) => {
        this.applyLifecycle(this.lifecycle.pageHide({ persisted: Boolean((event as PageTransitionEvent).persisted) }));
      });
      this.listen(this.options.browser.window, "pageshow", (event) => {
        this.applyLifecycle(this.lifecycle.pageShow({ persisted: Boolean((event as PageTransitionEvent).persisted) }));
      });
      this.applyLifecycle(this.lifecycle.visibilityChanged(this.options.browser.hidden()));
      this.applyLifecycle(this.lifecycle.onlineChanged(this.options.browser.online()));
      this.applyLifecycle(this.lifecycle.connect());
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopConnectionWork();
    this.retireSocket(1000, "dispose");
    this.metaOwner.dispose();
    this.tradesOwner.dispose();
    this.historyOwner.dispose();
    this.lifecycle.dispose();
    for (const { target, type, listener } of this.browserListeners.splice(0)) {
      target.removeEventListener(type, listener);
    }
    this.subscribers.clear();
    this.published = freeze(this.buildSnapshot());
  }

  getSnapshot(): MarketRuntimeSnapshot { return this.published; }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  selectInterval(interval: Interval): void {
    if (this.disposed || interval === this.selectedInterval) return;
    this.change(() => {
      this.selectedInterval = interval;
      if (this.active()) this.selectHistory("fresh");
    });
  }

  retry(): void {
    const state = this.lifecycle.getState();
    if (this.disposed || !this.started || state.hidden || !state.online || state.terminalReason) return;
    this.change(() => {
      this.lastError = null;
      if (this.active()) this.bootstrap(false);
      else {
        this.manualBootstrap = true;
        this.applyLifecycle(this.lifecycle.retry());
      }
    });
  }

  debug(command: DebugCommand): void {
    if (this.disposed) return;
    this.change(() => {
      if (!this.active()) { this.lastError = "Debug controls need a live connection."; return; }
      this.send({ type: "debug", session: this.session(), ...command });
    });
  }

  private now(): number { return this.options.clock.now(); }
  private session(): string | null { return this.lifecycle.getState().session; }

  private active(): boolean {
    return !this.disposed && this.helloReceived && this.connection !== null && this.lifecycle.getState().status === "live";
  }

  private visible(): boolean {
    const state = this.lifecycle.getState();
    return !state.hidden && state.online;
  }

  private current(epoch: number): boolean {
    return !this.disposed && this.connection?.epoch === epoch;
  }

  private accepts(epoch: number, session: string): boolean {
    return this.current(epoch) && this.helloReceived && this.session() === session;
  }

  private change(action: () => void): void {
    this.batchDepth += 1;
    try { action(); } finally { this.batchDepth -= 1; this.publish(); }
  }

  private listen(target: EventTarget, type: string, action: EventListener): void {
    const listener: EventListener = (event) => {
      if (!this.disposed) this.change(() => action(event));
    };
    target.addEventListener(type, listener);
    this.browserListeners.push({ target, type, listener });
  }

  private visibilityChanged(): void {
    const hidden = this.options.browser.hidden();
    this.applyLifecycle(this.lifecycle.visibilityChanged(hidden));
    this.freshness.visibilityChanged(hidden);
    if (hidden) this.clearTimer("helloTimer");
    else if (this.visible()) {
      if (!this.connection) this.applyLifecycle(this.lifecycle.connect());
      else if (!this.helloReceived) this.waitForHello(this.connection.epoch);
    }
  }

  private applyLifecycle(effects: LifecycleEffects): void {
    if (effects.closeSocket) {
      this.markStale();
      this.stopConnectionWork();
      this.retireSocket(1000, effects.closeSocket.reason);
    }
    if (effects.abortRequests) this.abortRequests();
    if (effects.stopProbes) this.stopMeasurements();
    if (effects.cancelTimers) {
      if (effects.cancelTimers.targets.includes("ping")) this.stopMeasurements();
      if (effects.cancelTimers.targets.includes("freshness")) this.clearTimer("healthTimer", true);
      if (effects.cancelTimers.targets.includes("reconnect")) this.clearTimer("reconnectTimer");
    }
    if (effects.clearEvidence) {
      this.telemetry.reset(this.lifecycle.getState().epoch);
      this.freshness.visibilityChanged(this.lifecycle.getState().hidden);
    }
    if (effects.openSocket) this.openSocket(effects.openSocket.epoch);
    if (effects.sendControl && this.active()) {
      this.send({ type: "visibility", session: this.session(), hidden: effects.sendControl.message.hidden });
    }
    if (effects.startProbes && this.active() && this.visible()) this.startMeasurements(true);
    if (effects.scheduleReconnect) {
      this.clearTimer("reconnectTimer");
      const { epoch, delayMs } = effects.scheduleReconnect;
      this.reconnectTimer = this.options.scheduler.setTimeout(() => {
        this.reconnectTimer = null;
        if (this.disposed || this.lifecycle.getState().epoch !== epoch) return;
        this.change(() => this.applyLifecycle(this.lifecycle.connect()));
      }, delayMs);
    }
  }

  private openSocket(epoch: number): void {
    this.stopConnectionWork();
    this.retireSocket(1000, "replace connection");
    this.feedReady = false;
    this.requestId = 0;
    this.pingId = 0;
    this.telemetry.reset(epoch);
    this.freshness.reset(epoch);
    this.freshness.visibilityChanged(this.lifecycle.getState().hidden);
    this.rate.reset(this.now());
    try {
      const socket = this.options.webSocket.open(this.options.urls.websocket);
      const listeners: Connection["listeners"] = {
        open: () => undefined,
        message: (event) => {
          if (this.current(epoch)) this.change(() => this.receive(epoch, event as MessageEvent));
        },
        close: (event) => {
          if (!this.current(epoch)) return;
          const close = event as CloseEvent;
          this.change(() => this.disconnected(epoch, close.code, close.reason));
        },
        error: () => {
          if (this.current(epoch)) this.change(() => { this.lastError = "Socket connection failed."; });
        },
      };
      this.connection = { socket, epoch, listeners };
      for (const type of ["open", "message", "close", "error"] as const) socket.addEventListener(type, listeners[type]);
      this.waitForHello(epoch);
    } catch (error) {
      this.lastError = errorText(error);
      this.applyLifecycle(this.lifecycle.socketClosed({ code: 1006, reason: "open failed" }, epoch));
    }
  }

  private waitForHello(epoch: number): void {
    this.clearTimer("helloTimer");
    if (!this.visible()) return;
    this.helloTimer = this.options.scheduler.setTimeout(() => {
      this.helloTimer = null;
      if (!this.current(epoch) || this.helloReceived || !this.visible()) return;
      this.change(() => {
        this.lastError = "Hello handshake timeout.";
        this.disconnected(epoch, 1006, "hello_timeout");
      });
    }, 10_000);
  }

  private retireSocket(code: number, reason: string): void {
    const connection = this.connection;
    this.connection = null;
    this.helloReceived = false;
    if (!connection) return;
    for (const type of ["open", "message", "close", "error"] as const) {
      connection.socket.removeEventListener(type, connection.listeners[type]);
    }
    try { connection.socket.close(code, reason); } catch (error) { this.lastError = errorText(error); }
  }

  private disconnected(epoch: number, code: number, reason: string): void {
    if (!this.current(epoch)) return;
    this.markStale();
    this.feedReady = false;
    this.stopConnectionWork();
    this.retireSocket(code === 4002 ? 4002 : 1000, code === 4002 ? "protocol_mismatch" : "connection ended");
    this.applyLifecycle(this.lifecycle.socketClosed({ code, reason }, epoch));
  }

  private markStale(): void {
    this.cachedStale = this.cachedStale || this.meta !== null || this.trades.getState().latestTradeId !== null ||
      this.book.getState().book.bids.length > 0 || this.candles.getState().candles.length > 0;
  }

  private receive(epoch: number, event: MessageEvent): void {
    let message: ServerEvent;
    try {
      if (typeof event.data !== "string") throw new Error("Expected a text socket message.");
      message = decodeRuntimeServerEvent(event.data, this.helloReceived ? "active" : "hello");
    } catch (error) {
      if (error instanceof ProtocolVersionError) {
        this.lastError = "Unsupported protocol version. Reload this page.";
        this.disconnected(epoch, 4002, "protocol_mismatch");
      } else {
        this.malformedMessages += 1;
        if (this.now() - this.lastMessageErrorAt >= 10_000) {
          this.lastError = errorText(error);
          this.lastMessageErrorAt = this.now();
        }
        if (!this.helloReceived) this.disconnected(epoch, 1006, "invalid hello");
      }
      return;
    }
    if (message.type === "hello") { this.hello(epoch, message); return; }
    if (message.session !== this.session()) {
      this.lastError = "Wrong session. Reconnecting.";
      this.disconnected(epoch, 1006, "wrong_session");
      return;
    }
    this.freshness.transportReceived(epoch);
    switch (message.type) {
      case "subscribed": break;
      case "pong": this.telemetry.pongReceived(message.id, this.now(), epoch); break;
      case "tier": this.tier = {
        effective: message.tier, auto: message.autoTier, forced: message.forced,
        hidden: message.hidden, flushMs: message.flushMs, reason: message.reason,
      }; break;
      case "heartbeat":
        this.feedReady = message.feedReady;
        this.freshness.heartbeat({
          epoch, marketRev: message.marketRev, flushMs: this.tier.flushMs ?? 500,
          advertisedHeads: {
            bookSeq: message.bookSeq,
            candle: message.candleRequestId !== null && message.candleLatestRev !== null
              ? { requestId: message.candleRequestId, revision: message.candleLatestRev } : undefined,
          },
        });
        break;
      case "update":
        if (message.book) {
          const expected = this.book.getState().expectedSeq;
          if (expected !== null && message.book.from > expected) this.bookError = "Gap detected. Fetching snapshot.";
          this.bookEffects(this.book.receiveRange({ session: message.session, ...message.book }, this.now(), message.wireBytes));
        }
        if (message.candles) {
          this.rate.record(this.now());
          this.candleEffects(this.candles.receiveLive({ session: message.session, ...message.candles }));
        }
        if (message.trades) {
          this.trades.merge(message.session, message.trades);
          this.skipped += message.skipped ?? 0;
        }
        this.freshness.heartbeat({ epoch, marketRev: message.marketRev, flushMs: this.tier.flushMs ?? 500 });
        this.reportApplied();
        break;
      case "book_reset":
        this.bookError = "Book resyncing. Fetching snapshot.";
        this.bookEffects(this.book.recover(this.now()));
        break;
      case "candles_reset":
        if (message.interval === this.selectedInterval && message.requestId === this.candles.getState().requestId) this.selectHistory("recover");
        break;
      case "error":
        this.lastError = message.message;
        if (message.code === "wrong_session") this.disconnected(epoch, 1006, "wrong_session");
        break;
    }
  }

  private hello(epoch: number, message: Extract<ServerEvent, { type: "hello" }>): void {
    const newSession = this.session() !== message.session;
    this.helloReceived = true;
    this.clearTimer("helloTimer");
    this.lifecycle.hello(message, epoch);
    this.freshness.transportReceived(epoch);
    this.tier = {
      effective: message.tier, auto: message.autoTier, forced: message.forced,
      hidden: message.hidden, flushMs: message.flushMs, reason: null,
    };
    if (newSession) {
      this.meta = null;
      this.trades.reset(message.session);
      this.candles.reset(message.session);
      this.bookError = null;
      this.skipped = 0;
      this.cachedStale = false;
    }
    this.bootstrap(!newSession && !this.manualBootstrap);
    this.manualBootstrap = false;
    if (this.lifecycle.getState().hidden) this.send({ type: "visibility", session: message.session, hidden: true });
    else this.startMeasurements(false);
  }

  private bootstrap(recover: boolean): void {
    const session = this.session();
    const epoch = this.connection?.epoch;
    if (!session || epoch === undefined || !this.active()) return;
    const metaTask: RequestTask<Meta> = {
      load: async (signal) => {
        const value = mapRuntimeMeta(await fetchRuntimeWire(this.options.fetcher, "meta", this.options.urls.meta, signal));
        if (!this.accepts(epoch, session)) throw new Error("Superseded metadata request.");
        if (value.session !== session) throw new Error("Metadata session mismatch.");
        return value;
      },
      accept: (value) => {
        if (!this.accepts(epoch, session)) throw new Error("Superseded metadata request.");
        this.meta = value;
      },
    };
    const tradeTask: RequestTask<RecentTradesDomain> = {
      load: async (signal) => {
        const value = mapRuntimeTrades(await fetchRuntimeWire(this.options.fetcher, "trades", this.options.urls.trades, signal));
        if (!this.accepts(epoch, session)) throw new Error("Superseded trades request.");
        if (value.session !== session) throw new Error("Trades session mismatch.");
        return value;
      },
      accept: (value) => {
        if (!this.accepts(epoch, session)) throw new Error("Superseded trades request.");
        this.trades.merge(session, value.trades);
      },
    };
    if (recover) {
      this.metaOwner.recover(metaTask);
      this.tradesOwner.recover(tradeTask);
      this.bookEffects(this.book.recover(this.now()));
    } else {
      this.metaOwner.start(metaTask);
      this.tradesOwner.start(tradeTask);
      this.bookEffects(this.book.start(session, this.now()));
    }
    this.selectHistory(recover ? "recover" : "fresh");
  }

  private selectHistory(mode: "fresh" | "recover"): void {
    const session = this.session();
    const epoch = this.connection?.epoch;
    if (!session || epoch === undefined || !this.active()) return;
    const interval = this.selectedInterval;
    const requestId = ++this.requestId;
    const effect = this.candles.select(interval, requestId).fetchHistory;
    if (!effect) return;
    this.freshness.selectedCandleRequest(requestId);
    const generation = effect.generation;
    const task: RequestTask<HistoryDomain> = {
      load: async (signal) => {
        const value = mapRuntimeHistory(await fetchRuntimeWire(this.options.fetcher, "history", this.options.urls.history(interval, requestId), signal));
        if (!this.accepts(epoch, session)) throw new Error("Superseded history request.");
        if (value.session !== session) throw new Error("History session mismatch.");
        if (value.interval !== interval || value.requestId !== requestId) throw new Error("History request identity mismatch.");
        return value;
      },
      accept: (value) => {
        if (!this.accepts(epoch, session)) throw new Error("Superseded history request.");
        this.change(() => {
          this.candleEffects(this.candles.receiveHistory(value, generation));
          this.reportApplied();
        });
      },
    };
    if (mode === "fresh") this.historyOwner.start(task);
    else this.historyOwner.recover(task);
    this.send({ type: "subscribe", session, interval, requestId });
  }

  private candleEffects(effects: CandleFeedEffects): void {
    if (effects.resync) this.selectHistory("recover");
  }

  private bookEffects(effects: BookSyncEffects): void {
    if (!effects.fetchSnapshot || !this.active()) return;
    this.fetchBook(effects.fetchSnapshot.generation, effects.fetchSnapshot.delayMs);
  }

  private fetchBook(generation: number, delayMs: number): void {
    const epoch = this.connection?.epoch;
    const session = this.session();
    if (epoch === undefined || !session) return;
    this.clearTimer("bookTimer");
    this.bookController?.abort();
    this.bookController = null;
    const current = () => this.accepts(epoch, session) && this.book.getState().generation === generation;
    const run = () => {
      this.bookTimer = null;
      if (!current()) return;
      const controller = new AbortController();
      this.bookController = controller;
      void fetchRuntimeWire(this.options.fetcher, "book", this.options.urls.book, controller.signal)
        .then((value) => {
          if (!current() || controller.signal.aborted) return;
          const snapshot = mapRuntimeBook(value);
          if (snapshot.session !== session) throw new Error("Book session mismatch.");
          this.change(() => {
            this.bookEffects(this.book.receiveSnapshot(snapshot, generation, this.now()));
            this.bookError = null;
            this.reportApplied();
          });
        })
        .catch((error: unknown) => {
          if (!current() || controller.signal.aborted) return;
          this.change(() => {
            this.bookError = errorText(error);
            this.bookEffects(this.book.failed(generation, this.now()));
          });
        })
        .finally(() => { if (this.bookController === controller) this.bookController = null; });
    };
    if (delayMs === 0) run();
    else this.bookTimer = this.options.scheduler.setTimeout(run, delayMs);
  }

  private reportApplied(): void {
    const epoch = this.connection?.epoch;
    if (epoch === undefined) return;
    const book = this.book.getState();
    if (book.status === "synced" && book.expectedSeq !== null) this.freshness.panelApplied({ epoch, panel: "book", head: book.expectedSeq - 1 });
    const candles = this.candles.getState();
    if (candles.requestId !== null && candles.candles.length > 0) {
      const head = Math.max(...candles.candles.map((candle) => candle.rev));
      this.freshness.panelApplied({ epoch, panel: "candles", head, requestId: candles.requestId });
    }
  }

  private startMeasurements(immediate: boolean): void {
    this.stopMeasurements();
    if (!this.active() || !this.visible()) return;
    const epoch = this.connection!.epoch;
    if (immediate) this.probe(epoch);
    this.pingTimer = this.options.scheduler.setInterval(() => {
      if (this.current(epoch) && this.visible()) this.change(() => this.probe(epoch));
    }, 1000);
    this.reportTimer = this.options.scheduler.setInterval(() => {
      if (!this.current(epoch) || !this.visible()) return;
      this.change(() => {
        this.telemetry.advance(this.now());
        const report = this.telemetry.report(this.now());
        if (report) this.send({ type: "report", session: this.session(), ...report });
      });
    }, 2000);
    this.clearTimer("healthTimer", true);
    this.healthTimer = this.options.scheduler.setInterval(() => {
      if (!this.current(epoch) || !this.visible()) return;
      this.change(() => {
        this.telemetry.advance(this.now());
        this.freshnessEffects(this.freshness.advance());
      });
    }, 1000);
  }

  private probe(epoch: number): void {
    if (!this.current(epoch) || !this.active() || !this.visible()) return;
    this.telemetry.advance(this.now());
    const effect = this.telemetry.pingSent(++this.pingId, this.now(), epoch);
    if (effect.ping) this.send({ type: "ping", session: this.session(), id: effect.ping.id });
  }

  private freshnessEffects(effects: FreshnessEffects): void {
    if (effects.reconnect) this.disconnected(effects.reconnect.epoch, 1006, effects.reconnect.reason);
    if (effects.resyncPanel?.panel === "book") this.bookEffects(this.book.recover(this.now()));
    if (effects.resyncPanel?.panel === "candles") this.selectHistory("recover");
  }

  private send(value: unknown): void {
    if (!this.active()) return;
    try { this.connection!.socket.send(encodeClientWire(value)); }
    catch (error) {
      this.lastError = errorText(error);
      if (this.connection) this.disconnected(this.connection.epoch, 1006, "send failed");
    }
  }

  private stopMeasurements(): void {
    this.clearTimer("pingTimer", true);
    this.clearTimer("reportTimer", true);
    this.clearTimer("healthTimer", true);
  }

  private abortRequests(): void {
    this.metaOwner.cancel({ preserveBudget: true });
    this.tradesOwner.cancel({ preserveBudget: true });
    this.historyOwner.cancel({ preserveBudget: true });
    this.clearTimer("bookTimer");
    this.bookController?.abort();
    this.bookController = null;
  }

  private stopConnectionWork(): void {
    this.stopMeasurements();
    this.clearTimer("helloTimer");
    this.clearTimer("reconnectTimer");
    this.abortRequests();
  }

  private clearTimer(name: Timer, interval = false): void {
    const id = this[name];
    this[name] = null;
    if (id !== null) {
      if (interval) this.options.scheduler.clearInterval(id);
      else this.options.scheduler.clearTimeout(id);
    }
  }

  private buildSnapshot(): MarketRuntimeSnapshot {
    const life = this.lifecycle.getState();
    const meta = this.metaOwner.getState();
    const tradeRequest = this.tradesOwner.getState();
    const history = this.historyOwner.getState();
    const book = this.book.getState();
    const candles = this.candles.getState();
    const trades = this.trades.getState();
    const fresh = this.freshness.getState();
    const measurement = this.telemetry.report(this.now());
    const telemetry = this.telemetry.getState();
    const bootstrapReady = this.active() && meta.status === "ready" && this.meta?.session === life.session &&
      book.status === "synced" && tradeRequest.status === "ready" && history.status === "ready" &&
      candles.interval === this.selectedInterval && candles.requestId === this.requestId && candles.status === "ready";
    if (bootstrapReady) this.cachedStale = false;
    const exhausted = [meta, tradeRequest, history].some((state) => state.status === "failed" || (state.status === "idle" && state.attemptsUsed >= 5));
    const manualRetryRequired = life.manualRetryRequired || exhausted || book.status === "failed";
    const liveEligible = bootstrapReady && !this.cachedStale && !manualRetryRequired && this.visible() && this.feedReady && fresh.condition === "live";
    return {
      connection: { status: life.status, hidden: life.hidden, online: life.online, reconnectAttempts: life.reconnectAttempts, terminalReason: life.terminalReason },
      epoch: life.epoch, session: life.session, symbol: life.session ? "BTC-USD" : null,
      selectedInterval: this.selectedInterval, reloadRequired: life.terminalReason !== null,
      manualRetryRequired, cachedStale: this.cachedStale, liveEligible,
      meta: { status: meta.status, value: this.meta, error: meta.error, attemptsUsed: meta.attemptsUsed },
      book: {
        status: book.status, expectedSeq: book.expectedSeq, attemptsUsed: book.attemptsUsed,
        bufferedRanges: book.bufferedRanges, bufferedBytes: book.bufferedBytes, bids: book.book.bids, asks: book.book.asks,
      },
      candles: {
        status: candles.status, historyStatus: history.status, interval: candles.interval, requestId: candles.requestId,
        candles: candles.candles, attemptsUsed: history.attemptsUsed, error: history.error,
      },
      trades: {
        status: tradeRequest.status, error: tradeRequest.error, attemptsUsed: tradeRequest.attemptsUsed,
        value: trades.session ? { session: trades.session, symbol: "BTC-USD", trades: trades.trades } : null,
        latestPriceTicks: trades.latestPriceTicks, latestTradeId: trades.latestTradeId, skippedDisplayRecords: this.skipped,
      },
      telemetry: { unresolved: telemetry.unresolved, timedOutIds: telemetry.timedOutIds, successes: telemetry.successes, measurement },
      freshness: { condition: fresh.condition, lastTransportAtMs: fresh.lastTransportAtMs, lastMarketRev: fresh.lastMarketRev },
      tier: { ...this.tier }, observedRate: this.rate.read(this.now()),
      diagnostics: {
        lastError: this.lastError, malformedMessages: this.malformedMessages, staleCallbacksIgnored: 0,
        requestErrors: { meta: meta.error, book: this.bookError, trades: tradeRequest.error, history: history.error },
      },
    };
  }

  private publish(): void {
    if (this.disposed || this.batchDepth > 0) return;
    const next = this.buildSnapshot();
    this.lifecycle.healthySynchronized(next.liveEligible);
    this.lifecycle.advance();
    next.connection.reconnectAttempts = this.lifecycle.getState().reconnectAttempts;
    this.published = freeze(next);
    for (const listener of [...this.subscribers]) listener();
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "Request failed.").slice(0, 160);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createInitialSnapshot(selectedInterval: Interval): MarketRuntimeSnapshot {
  return {
    connection: {
      status: "idle",
      hidden: false,
      online: true,
      reconnectAttempts: 0,
      terminalReason: null,
    },
    epoch: 0,
    session: null,
    symbol: null,
    selectedInterval,
    reloadRequired: false,
    manualRetryRequired: false,
    cachedStale: false,
    liveEligible: false,
    meta: {
      status: "idle",
      value: null,
      error: null,
      attemptsUsed: 0,
    },
    book: {
      status: "idle",
      expectedSeq: null,
      attemptsUsed: 0,
      bufferedRanges: 0,
      bufferedBytes: 0,
      bids: [],
      asks: [],
    },
    candles: {
      status: "idle",
      historyStatus: "idle",
      interval: null,
      requestId: null,
      candles: [],
      attemptsUsed: 0,
      error: null,
    },
    trades: {
      status: "idle",
      value: null,
      error: null,
      attemptsUsed: 0,
      latestPriceTicks: null,
      latestTradeId: null,
      skippedDisplayRecords: 0,
    },
    telemetry: {
      unresolved: 0,
      timedOutIds: [],
      measurement: null,
      successes: [],
    },
    freshness: {
      condition: "waiting",
      lastTransportAtMs: null,
      lastMarketRev: null,
    },
    tier: {
      effective: null,
      auto: null,
      forced: null,
      hidden: false,
      flushMs: null,
      reason: null,
    },
    observedRate: {
      valuePerSecond: null,
      windowMs: 10_000,
      sampleCount: 0,
    },
    diagnostics: {
      lastError: null,
      malformedMessages: 0,
      staleCallbacksIgnored: 0,
      requestErrors: {
        meta: null,
        book: null,
        trades: null,
        history: null,
      },
    },
  };
}
