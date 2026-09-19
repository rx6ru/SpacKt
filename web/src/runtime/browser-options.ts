import type { Interval } from "../domain/model";
import type {
  BrowserEvents,
  MarketRuntimeOptions,
  RuntimeSocket,
  Scheduler,
  WebSocketDriver,
} from "./types";

const defaultBackendURL = "http://localhost:8080";

export function createBrowserRuntimeOptions(defaultInterval: Interval): MarketRuntimeOptions {
  const apiBase = normalizeBaseURL(process.env.NEXT_PUBLIC_API_URL ?? defaultBackendURL);

  return {
    urls: {
      websocket: toWebSocketURL(apiBase),
      meta: `${apiBase}/api/meta`,
      book: `${apiBase}/api/book`,
      trades: `${apiBase}/api/trades?limit=50`,
      history: (interval, requestId) =>
        `${apiBase}/api/candles?interval=${encodeURIComponent(interval)}&limit=500&requestId=${requestId}`,
    },
    defaultInterval,
    protocolVersion: 1,
    fetcher: window.fetch.bind(window),
    webSocket: browserWebSocketDriver,
    clock: { now: () => performance.now() },
    scheduler: browserScheduler,
    browser: browserEvents,
    random: Math.random,
  };
}

function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, "");
}

function toWebSocketURL(apiBase: string): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

const browserWebSocketDriver: WebSocketDriver = {
  open(url: string): RuntimeSocket {
    return new WebSocket(url);
  },
};

const browserScheduler: Scheduler = {
  setTimeout(callback, delayMs) {
    return window.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    window.clearTimeout(handle as number);
  },
  setInterval(callback, delayMs) {
    return window.setInterval(callback, delayMs);
  },
  clearInterval(handle) {
    window.clearInterval(handle as number);
  },
};

const browserEvents: BrowserEvents = {
  get window(): EventTarget {
    return window;
  },
  get document(): EventTarget {
    return document;
  },
  hidden() {
    return document.hidden;
  },
  online() {
    return navigator.onLine;
  },
};
