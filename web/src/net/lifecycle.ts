export type LifecycleEffects = {
  openSocket?: { epoch: number; reloadFreshState?: boolean };
  closeSocket?: { epoch: number; code: 1000 | 1001; reason: string };
  sendControl?: { epoch: number; message: { type: "visibility"; hidden: boolean } };
  resetEngines?: {
    epoch: number;
    session: string;
    engines: ["book", "candles", "trades", "telemetry", "freshness"];
  };
  startProbes?: { epoch: number };
  stopProbes?: { epoch: number };
  clearEvidence?: { epoch: number; targets: Array<"rtt" | "freshness"> };
  scheduleReconnect?: { epoch: number; delayMs: number; reason: string };
  cancelTimers?: { epoch: number; targets: Array<"ping" | "reconnect" | "freshness" | "hiddenTimeout"> };
  abortRequests?: { epoch: number; reason: string };
  cleanup?: {
    epoch: number;
    timers: true;
    socket: true;
    domListeners: true;
    requests: true;
    charts: true;
  };
};

export type LifecycleState = {
  epoch: number;
  session: string | null;
  hidden: boolean;
  online: boolean;
  disposed: boolean;
  status: "idle" | "connecting" | "live" | "reconnecting" | "offline" | "terminal";
  terminalReason: "protocol_mismatch" | "reload_required" | null;
  reconnectAttempts: number;
  staleCachedData: boolean;
  manualRetryRequired: boolean;
  hiddenClosed: boolean;
};

export class ConnectionLifecycle {
  constructor(_options: {
    now: () => number;
    random: () => number;
    protocolVersion: number;
  }) {}

  connect(): LifecycleEffects { throw new Error("Not implemented"); }
  hello(message: { session: string; protocolVersion: number }, epoch?: number): LifecycleEffects { throw new Error("Not implemented"); }
  visibilityChanged(hidden: boolean): LifecycleEffects { throw new Error("Not implemented"); }
  onlineChanged(online: boolean): LifecycleEffects { throw new Error("Not implemented"); }
  pageHide(event: { persisted: boolean }): LifecycleEffects { throw new Error("Not implemented"); }
  pageShow(event: { persisted: boolean }): LifecycleEffects { throw new Error("Not implemented"); }
  socketClosed(event: { code: number; reason?: string }, epoch?: number): LifecycleEffects { throw new Error("Not implemented"); }
  healthySynchronized(healthy?: boolean): LifecycleEffects { throw new Error("Not implemented"); }
  retry(): LifecycleEffects { throw new Error("Not implemented"); }
  advance(): LifecycleEffects { throw new Error("Not implemented"); }
  dispose(): LifecycleEffects { throw new Error("Not implemented"); }
  getState(): LifecycleState { throw new Error("Not implemented"); }
}
