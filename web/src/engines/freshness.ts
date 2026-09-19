export type HeartbeatEvidence = {
  epoch: number;
  marketRev: number;
  flushMs: number;
  advertisedHeads?: {
    bookSeq?: number;
    candle?: { requestId: number; revision: number };
  };
};

export type PanelAppliedEvidence =
  | {
      epoch: number;
      panel: "book";
      head: number;
      requestId?: never;
    }
  | {
      epoch: number;
      panel: "candles";
      head: number;
      requestId: number;
    };

export type FreshnessEffects = {
  reconnect?: { epoch: number; reason: "transport_silence" };
  markFeedDelayed?: { epoch: number; delayed: boolean };
  resyncPanel?: {
    epoch: number;
    panel: "book" | "candles";
    reason: "advertised_head_stalled";
  };
  clearEvidence?: { epoch: number };
};

export type FreshnessState = {
  epoch: number;
  hidden: boolean;
  condition: "waiting" | "live" | "stale" | "feed-delayed";
  lastTransportAtMs: number | null;
  lastMarketRev: number | null;
  selectedCandleRequestId: number | null;
};

type PanelName = "book" | "candles";

type PanelEvidenceState = {
  localHead: number | null;
  advertisedHead: number | null;
  stalledSinceMs: number | null;
  flushMs: number;
  resynced: boolean;
};

const makePanelState = (): PanelEvidenceState => ({
  localHead: null,
  advertisedHead: null,
  stalledSinceMs: null,
  flushMs: 0,
  resynced: false,
});

export class FreshnessMonitor {
  private readonly now: () => number;
  private state: FreshnessState = {
    epoch: 0,
    hidden: false,
    condition: "waiting",
    lastTransportAtMs: null,
    lastMarketRev: null,
    selectedCandleRequestId: null,
  };
  private lastMarketRevAtMs: number | null = null;
  private readonly panels: Record<PanelName, PanelEvidenceState> = {
    book: makePanelState(),
    candles: makePanelState(),
  };

  constructor(options: { now: () => number }) {
    this.now = options.now;
  }

  reset(epoch: number): FreshnessEffects {
    this.state = {
      epoch,
      hidden: false,
      condition: "waiting",
      lastTransportAtMs: null,
      lastMarketRev: null,
      selectedCandleRequestId: null,
    };
    this.lastMarketRevAtMs = null;
    this.resetPanels();
    return {};
  }

  visibilityChanged(hidden: boolean): FreshnessEffects {
    if (this.state.hidden === hidden) {
      return {};
    }

    this.state.hidden = hidden;

    if (hidden) {
      return {};
    }

    this.state.condition = "waiting";
    this.state.lastTransportAtMs = null;
    this.state.lastMarketRev = null;
    this.lastMarketRevAtMs = null;
    this.resetPanels();

    return { clearEvidence: { epoch: this.state.epoch } };
  }

  transportReceived(epoch: number): FreshnessEffects {
    if (this.shouldIgnore(epoch)) {
      return {};
    }

    this.state.lastTransportAtMs = this.now();
    if (this.state.condition === "stale") {
      this.state.condition = this.state.lastMarketRev === null ? "waiting" : "live";
    }
    return {};
  }

  heartbeat(message: HeartbeatEvidence): FreshnessEffects {
    if (this.shouldIgnore(message.epoch)) {
      return {};
    }

    if (this.state.lastMarketRev !== message.marketRev) {
      this.state.lastMarketRev = message.marketRev;
      this.lastMarketRevAtMs = this.now();
      this.state.condition = "live";
    }

    const advertisedHeads = message.advertisedHeads;
    if (advertisedHeads?.bookSeq !== undefined) {
      this.recordAdvertisedHead("book", advertisedHeads.bookSeq, message.flushMs);
    }

    const candle = advertisedHeads?.candle;
    if (
      candle !== undefined &&
      candle.requestId === this.state.selectedCandleRequestId
    ) {
      this.recordAdvertisedHead("candles", candle.revision, message.flushMs);
    }

    return {};
  }

  panelApplied(message: PanelAppliedEvidence): FreshnessEffects {
    if (this.shouldIgnore(message.epoch)) {
      return {};
    }

    if (message.panel === "book" && message.requestId !== undefined) {
      return {};
    }

    if (
      message.panel === "candles" &&
      message.requestId !== this.state.selectedCandleRequestId
    ) {
      return {};
    }

    const panel = this.panels[message.panel];
    if (panel.localHead === null || message.head > panel.localHead) {
      panel.localHead = message.head;
      panel.resynced = false;
      if (panel.advertisedHead !== null && panel.localHead < panel.advertisedHead) {
        panel.stalledSinceMs = this.now();
      } else {
        panel.stalledSinceMs = null;
      }
    }

    return {};
  }

  selectedCandleRequest(requestId: number): FreshnessEffects {
    if (this.state.selectedCandleRequestId !== requestId) {
      this.state.selectedCandleRequestId = requestId;
      this.panels.candles = makePanelState();
    }

    return {};
  }

  advance(): FreshnessEffects {
    if (this.state.hidden) {
      return {};
    }

    const now = this.now();
    if (
      this.state.lastTransportAtMs !== null &&
      now - this.state.lastTransportAtMs >= 10_000
    ) {
      this.state.condition = "stale";
      return { reconnect: { epoch: this.state.epoch, reason: "transport_silence" } };
    }

    const stalledPanel = this.findStalledPanel(now);
    if (stalledPanel !== null) {
      this.panels[stalledPanel].resynced = true;
      return {
        resyncPanel: {
          epoch: this.state.epoch,
          panel: stalledPanel,
          reason: "advertised_head_stalled",
        },
      };
    }

    if (
      this.lastMarketRevAtMs !== null &&
      now - this.lastMarketRevAtMs >= 5_000 &&
      this.state.condition !== "feed-delayed"
    ) {
      this.state.condition = "feed-delayed";
      return { markFeedDelayed: { epoch: this.state.epoch, delayed: true } };
    }

    return {};
  }

  getState(): FreshnessState {
    return { ...this.state };
  }

  private shouldIgnore(epoch: number): boolean {
    return this.state.hidden || epoch !== this.state.epoch;
  }

  private resetPanels(): void {
    this.panels.book = makePanelState();
    this.panels.candles = makePanelState();
  }

  private recordAdvertisedHead(
    panelName: PanelName,
    advertisedHead: number,
    flushMs: number,
  ): void {
    const panel = this.panels[panelName];
    const wasAhead = panel.localHead !== null && panel.advertisedHead !== null
      ? panel.advertisedHead > panel.localHead
      : false;
    panel.advertisedHead = advertisedHead;
    panel.flushMs = flushMs;

    if (panel.localHead !== null && advertisedHead <= panel.localHead) {
      panel.stalledSinceMs = null;
      panel.resynced = false;
      return;
    }

    if (
      panel.localHead !== null &&
      advertisedHead > panel.localHead &&
      (!wasAhead || panel.stalledSinceMs === null)
    ) {
      panel.stalledSinceMs = this.now();
      panel.resynced = false;
    }
  }

  private findStalledPanel(now: number): PanelName | null {
    for (const panelName of ["book", "candles"] as const) {
      const panel = this.panels[panelName];
      if (
        panel.localHead === null ||
        panel.advertisedHead === null ||
        panel.advertisedHead <= panel.localHead ||
        panel.stalledSinceMs === null ||
        panel.resynced
      ) {
        continue;
      }

      const thresholdMs = Math.max(5_000, 3 * panel.flushMs);
      if (now - panel.stalledSinceMs >= thresholdMs) {
        return panelName;
      }
    }

    return null;
  }
}
