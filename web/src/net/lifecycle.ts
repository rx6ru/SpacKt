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

type LifecycleOptions = {
  now: () => number;
  random: () => number;
  protocolVersion: number;
};

const engineResetOrder = [
  "book",
  "candles",
  "trades",
  "telemetry",
  "freshness",
] as const;

const timerTargets = [
  "ping",
  "reconnect",
  "freshness",
  "hiddenTimeout",
] as const;

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
  private readonly options: LifecycleOptions;
  private state: LifecycleState = {
    epoch: 0,
    session: null,
    hidden: false,
    online: true,
    disposed: false,
    status: "idle",
    terminalReason: null,
    reconnectAttempts: 0,
    staleCachedData: false,
    manualRetryRequired: false,
    hiddenClosed: false,
  };
  private healthySinceMs: number | null = null;
  private reloadFreshOnNextOpen = false;
  private payloadRetryAvailable = true;

  constructor(options: LifecycleOptions) {
    this.options = options;
  }

  connect(): LifecycleEffects {
    if (!this.canOpen()) {
      return {};
    }

    return this.openSocket(this.reloadFreshOnNextOpen);
  }

  hello(
    message: { session: string; protocolVersion: number },
    epoch = this.state.epoch,
  ): LifecycleEffects {
    if (this.shouldIgnoreEpoch(epoch)) {
      return {};
    }

    if (message.protocolVersion !== this.options.protocolVersion) {
      this.state.status = "terminal";
      this.state.terminalReason = "reload_required";
      return {};
    }

    const sessionChanged = this.state.session !== message.session;
    this.state.session = message.session;
    this.state.status = "live";
    this.state.hiddenClosed = false;

    if (!sessionChanged) {
      return {};
    }

    return {
      resetEngines: {
        epoch,
        session: message.session,
        engines: [...engineResetOrder],
      },
    };
  }

  visibilityChanged(hidden: boolean): LifecycleEffects {
    if (this.state.disposed || this.state.hidden === hidden) {
      return {};
    }

    this.state.hidden = hidden;
    this.healthySinceMs = null;

    if (hidden) {
      return {
        sendControl: { epoch: this.state.epoch, message: { type: "visibility", hidden } },
        stopProbes: { epoch: this.state.epoch },
        clearEvidence: { epoch: this.state.epoch, targets: ["rtt", "freshness"] },
        cancelTimers: { epoch: this.state.epoch, targets: ["ping", "freshness"] },
      };
    }

    if (this.state.hiddenClosed && this.canOpen()) {
      this.state.hiddenClosed = false;
      return this.openSocket(false);
    }

    return {
      sendControl: { epoch: this.state.epoch, message: { type: "visibility", hidden } },
      startProbes: { epoch: this.state.epoch },
      clearEvidence: { epoch: this.state.epoch, targets: ["rtt", "freshness"] },
    };
  }

  onlineChanged(online: boolean): LifecycleEffects {
    if (this.state.disposed || this.state.online === online) {
      return {};
    }

    this.state.online = online;
    this.healthySinceMs = null;

    if (!online) {
      this.state.status = "offline";
      return {
        closeSocket: { epoch: this.state.epoch, code: 1001, reason: "offline" },
        cancelTimers: { epoch: this.state.epoch, targets: [...timerTargets] },
        abortRequests: { epoch: this.state.epoch, reason: "offline" },
      };
    }

    if (!this.canOpen()) {
      return {};
    }

    return this.openSocket(false);
  }

  pageHide(event: { persisted: boolean }): LifecycleEffects {
    void event;

    if (this.state.disposed) {
      return {};
    }

    this.state.status = "idle";
    this.healthySinceMs = null;

    return {
      closeSocket: { epoch: this.state.epoch, code: 1001, reason: "pagehide" },
      cancelTimers: { epoch: this.state.epoch, targets: [...timerTargets] },
      abortRequests: { epoch: this.state.epoch, reason: "pagehide" },
    };
  }

  pageShow(event: { persisted: boolean }): LifecycleEffects {
    if (this.state.disposed || !event.persisted || !this.canOpen()) {
      return {};
    }

    const effects = this.openSocket(true);
    effects.clearEvidence = { epoch: this.state.epoch, targets: ["rtt", "freshness"] };
    return effects;
  }

  socketClosed(
    event: { code: number; reason?: string },
    epoch = this.state.epoch,
  ): LifecycleEffects {
    if (this.shouldIgnoreEpoch(epoch)) {
      return {};
    }

    this.healthySinceMs = null;

    if (this.state.hidden || !this.state.online) {
      this.state.status = this.state.online ? "idle" : "offline";
      if (event.code === 4001) {
        this.state.hiddenClosed = true;
      }
      return {};
    }

    if (event.code === 4001) {
      return this.openSocket(false);
    }

    if (event.code === 4002) {
      this.state.status = "terminal";
      this.state.terminalReason = "protocol_mismatch";
      return {};
    }

    if (event.code === 4008) {
      return this.scheduleReconnect(this.retryAfterDelay(), "rate_limited");
    }

    if (event.code === 4009) {
      this.state.staleCachedData = true;
      this.reloadFreshOnNextOpen = true;

      if (!this.payloadRetryAvailable) {
        this.state.manualRetryRequired = true;
        this.state.status = "idle";
        return {};
      }

      this.payloadRetryAvailable = false;
      return this.scheduleReconnect(this.retryAfterDelay(), "payload_too_large");
    }

    const capMs = Math.min(10_000, 500 * 2 ** this.state.reconnectAttempts);
    const delayMs = Math.floor(this.options.random() * capMs);
    return this.scheduleReconnect(delayMs, "socket_closed");
  }

  healthySynchronized(healthy = true): LifecycleEffects {
    if (this.state.disposed) {
      return {};
    }

    if (!healthy) {
      this.healthySinceMs = null;
      return {};
    }

    this.healthySinceMs ??= this.options.now();
    return {};
  }

  retry(): LifecycleEffects {
    if (
      this.state.disposed ||
      this.state.terminalReason !== null ||
      this.state.hidden ||
      !this.state.online
    ) {
      return {};
    }

    if (this.state.manualRetryRequired) {
      this.state.manualRetryRequired = false;
      this.payloadRetryAvailable = true;
      return this.openSocket(true);
    }

    return this.openSocket(this.reloadFreshOnNextOpen);
  }

  advance(): LifecycleEffects {
    if (this.state.disposed || this.healthySinceMs === null) {
      return {};
    }

    if (this.options.now() - this.healthySinceMs >= 30_000) {
      this.state.reconnectAttempts = 0;
      this.payloadRetryAvailable = true;
      this.healthySinceMs = null;
    }

    return {};
  }

  dispose(): LifecycleEffects {
    if (this.state.disposed) {
      return {};
    }

    this.state.disposed = true;
    this.state.status = "terminal";
    this.healthySinceMs = null;

    return {
      cleanup: {
        epoch: this.state.epoch,
        timers: true,
        socket: true,
        domListeners: true,
        requests: true,
        charts: true,
      },
    };
  }

  getState(): LifecycleState {
    return { ...this.state };
  }

  private canOpen(): boolean {
    return (
      !this.state.disposed &&
      this.state.terminalReason === null &&
      !this.state.hidden &&
      this.state.online &&
      !this.state.manualRetryRequired
    );
  }

  private shouldIgnoreEpoch(epoch: number): boolean {
    return this.state.disposed || epoch !== this.state.epoch;
  }

  private openSocket(reloadFreshState: boolean): LifecycleEffects {
    this.state.epoch += 1;
    this.state.status = "connecting";
    this.reloadFreshOnNextOpen = false;
    const openSocket: LifecycleEffects["openSocket"] = { epoch: this.state.epoch };
    if (reloadFreshState) {
      openSocket.reloadFreshState = true;
    }
    return { openSocket };
  }

  private scheduleReconnect(
    delayMs: number,
    reason: string,
  ): LifecycleEffects {
    this.state.status = "reconnecting";
    this.state.reconnectAttempts += 1;
    return {
      scheduleReconnect: {
        epoch: this.state.epoch,
        delayMs,
        reason,
      },
    };
  }

  private retryAfterDelay(): number {
    return 10_000 + Math.floor(this.options.random() * 20_000);
  }
}
