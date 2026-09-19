// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import { createInitialSnapshot } from "../runtime/create-market-runtime";
import { ConnectionStatus } from "./status";

function snapshot(overrides: Partial<MarketRuntimeSnapshot> = {}): MarketRuntimeSnapshot {
  const base = createInitialSnapshot("1m");
  return {
    ...base,
    connection: {
      ...base.connection,
      status: "live",
      online: true,
      ...overrides.connection,
    },
    session: "session-1",
    symbol: "BTC-USD",
    liveEligible: true,
    meta: {
      ...base.meta,
      status: "ready",
      ...overrides.meta,
    },
    freshness: {
      ...base.freshness,
      condition: "live",
      ...overrides.freshness,
    },
    tier: {
      ...base.tier,
      effective: "full",
      flushMs: 50,
      ...overrides.tier,
    },
    telemetry: {
      ...base.telemetry,
      measurement: { latencyMs: 22, jitterMs: 4, samples: 3 },
      ...overrides.telemetry,
    },
    observedRate: {
      ...base.observedRate,
      valuePerSecond: 20,
      sampleCount: 4,
      ...overrides.observedRate,
    },
    ...overrides,
  };
}

function renderStatus(view: MarketRuntimeSnapshot) {
  const onRetry = vi.fn();
  render(<ConnectionStatus snapshot={view} onRetry={onRetry} />);
  return { onRetry };
}

afterEach(() => {
  cleanup();
});

describe("ConnectionStatus", () => {
  it("shows Reload without Retry when the terminal protocol requires reload", () => {
    renderStatus(snapshot({
      reloadRequired: true,
      manualRetryRequired: false,
      connection: {
        ...createInitialSnapshot("1m").connection,
        status: "terminal",
        online: true,
        terminalReason: "protocol_mismatch",
      },
    }));

    expect(screen.getByText("Reload required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows Retry when manual retry is required", () => {
    renderStatus(snapshot({
      manualRetryRequired: true,
      connection: {
        ...createInitialSnapshot("1m").connection,
        status: "offline",
        online: false,
      },
    }));

    expect(screen.getByText("Recovery failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("shows offline only when the snapshot reports the connection is offline", () => {
    const { rerender } = render(<ConnectionStatus snapshot={snapshot()} onRetry={vi.fn()} />);

    expect(screen.queryByText("Offline")).toBeNull();

    rerender(<ConnectionStatus snapshot={snapshot({
      connection: {
        ...createInitialSnapshot("1m").connection,
        status: "offline",
        online: false,
      },
    })} onRetry={vi.fn()} />);

    expect(screen.getByText("Offline")).toBeTruthy();
  });

  it("shows cached values only when the snapshot reports stale cached state", () => {
    const { rerender } = render(<ConnectionStatus snapshot={snapshot()} onRetry={vi.fn()} />);

    expect(screen.queryByText("Cached values")).toBeNull();

    rerender(<ConnectionStatus snapshot={snapshot({ cachedStale: true })} onRetry={vi.fn()} />);

    expect(screen.getByText("Cached values")).toBeTruthy();
  });

  it("does not show Live when the snapshot is not live eligible", () => {
    renderStatus(snapshot({
      liveEligible: false,
      freshness: {
        ...createInitialSnapshot("1m").freshness,
        condition: "waiting",
      },
    }));

    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.getByText("Waiting for market")).toBeTruthy();
  });
});
