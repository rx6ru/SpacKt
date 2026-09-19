import type { DebugCommand } from "../domain/events";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import type { Interval } from "../domain/model";

export type MarketRuntime = {
  start(): void;
  dispose(): void;
  selectInterval(interval: Interval): void;
  retry(): void;
  debug(command: DebugCommand): void;
  getSnapshot(): MarketRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
};

export type MarketRuntimeOptions = {
  urls: {
    websocket: string;
    meta: string;
    book: string;
    trades: string;
    history: (interval: Interval, requestId: number) => string;
  };
  defaultInterval: Interval;
  protocolVersion: 1;
  fetcher: typeof fetch;
  webSocket: WebSocketDriver;
  clock: { now(): number };
  scheduler: Scheduler;
  browser: BrowserEvents;
  random: () => number;
};

export type WebSocketDriver = {
  open(url: string): RuntimeSocket;
};

export type BrowserCloseCode = number;

export type RuntimeSocket = {
  send(data: string): void;
  close(code?: BrowserCloseCode, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: EventListener): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: EventListener): void;
};

export type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
};

export type BrowserEvents = {
  window: EventTarget;
  document: EventTarget;
  hidden(): boolean;
  online(): boolean;
};
