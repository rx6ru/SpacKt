// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DebugCommand, MarketRuntimeSnapshot } from "../domain/market-view";
import { createInitialSnapshot } from "../runtime/create-market-runtime";
import { DiagnosticsDrawer } from "./diagnostics";

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
    book: {
      ...base.book,
      status: "synced",
      ...overrides.book,
    },
    freshness: {
      ...base.freshness,
      condition: "live",
      ...overrides.freshness,
    },
    tier: {
      ...base.tier,
      effective: "full",
      auto: "full",
      flushMs: 50,
      ...overrides.tier,
    },
    observedRate: {
      ...base.observedRate,
      valuePerSecond: 20,
      sampleCount: 4,
      ...overrides.observedRate,
    },
    telemetry: {
      ...base.telemetry,
      measurement: { latencyMs: 24, jitterMs: 3, samples: 4 },
      ...overrides.telemetry,
    },
    diagnostics: {
      ...base.diagnostics,
      ...overrides.diagnostics,
    },
    ...overrides,
  };
}

function renderDiagnostics(view = snapshot()) {
  const onDebug = vi.fn<(command: DebugCommand) => void>();
  const onRetry = vi.fn();
  render(<DiagnosticsDrawer snapshot={view} onDebug={onDebug} onRetry={onRetry} />);
  return { onDebug, onRetry };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DiagnosticsDrawer", () => {
  it("does not show book resyncing when a debug click has not changed the live snapshot", () => {
    const { onDebug } = renderDiagnostics();
    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    const dialog = screen.getByRole("dialog", { name: "Diagnostics and debug controls" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Drop next book delta" }));

    expect(onDebug).toHaveBeenCalledWith({ action: "dropNextBookDelta" });
    expect(within(dialog).queryByText("Book resyncing")).toBeNull();
  });

  it("does not show offline when a debug click has not changed the live snapshot", () => {
    const { onDebug } = renderDiagnostics();
    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    const dialog = screen.getByRole("dialog", { name: "Diagnostics and debug controls" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect this session" }));

    expect(onDebug).toHaveBeenCalledWith({ action: "disconnect" });
    expect(within(dialog).queryByText("Offline")).toBeNull();
  });

  it("shows reconnecting transport state when the runtime snapshot reports it", () => {
    renderDiagnostics(snapshot({
      connection: { ...createInitialSnapshot("1m").connection, status: "reconnecting", online: false },
      cachedStale: true,
      freshness: { ...createInitialSnapshot("1m").freshness, condition: "stale" },
    }));

    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    const dialog = screen.getByRole("dialog", { name: "Diagnostics and debug controls" });

    expect(within(dialog).getByText("reconnecting")).toBeTruthy();
  });

  it("opens one diagnostics form owner without duplicate input ids", () => {
    renderDiagnostics();

    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));

    expect(screen.getByRole("dialog", { name: "Diagnostics and debug controls" })).toBeTruthy();
    expect(document.querySelectorAll("#pong-delay")).toHaveLength(1);
  });

  it("uses radio semantics for the force tier control", () => {
    renderDiagnostics();

    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    const dialog = screen.getByRole("dialog", { name: "Diagnostics and debug controls" });
    const tierGroup = within(dialog).getByRole("radiogroup", { name: "Force delivery tier" });

    expect(within(tierGroup).getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("true");
    expect(within(tierGroup).getByRole("radio", { name: "Full" }).getAttribute("aria-checked")).toBe("false");
  });

  it("closes the dialog on Escape and returns focus to the opener", async () => {
    renderDiagnostics();
    const opener = screen.getByRole("button", { name: "Open diagnostics" });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Diagnostics and debug controls" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("clears owned cooldown timers on unmount", () => {
    vi.useFakeTimers();
    const timeoutHandles: number[] = [];
    const realSetTimeout = window.setTimeout;
    vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const handle = realSetTimeout(handler, timeout, ...args) as number;
      if (timeout === 1000) {
        timeoutHandles.push(handle);
      }
      return handle;
    }) as typeof window.setTimeout);
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = render(<DiagnosticsDrawer snapshot={snapshot()} onDebug={vi.fn()} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    const dialog = screen.getByRole("dialog", { name: "Diagnostics and debug controls" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Apply pong delay" }));
    const [cooldownHandle] = timeoutHandles;
    unmount();

    expect(cooldownHandle).toBeDefined();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(cooldownHandle);
  });
});
