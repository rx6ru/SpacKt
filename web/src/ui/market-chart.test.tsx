// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import type { Candle, Interval } from "../domain/model";
import { createInitialSnapshot } from "../runtime/create-market-runtime";
import { MarketChart } from "./market-chart";

const chartPort = vi.hoisted(() => {
  type Adapter = {
    setCandles: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };

  return {
    adapter: undefined as Adapter | undefined,
    onInspect: undefined as ((candle: Candle | null) => void) | undefined,
    mountCandleChart: vi.fn((container: HTMLElement, options: { onInspect: (candle: Candle | null) => void }) => {
      void container;
      chartPort.onInspect = options.onInspect;
      chartPort.adapter = {
        setCandles: vi.fn(),
        inspect: vi.fn(),
        dispose: vi.fn(),
      };
      return chartPort.adapter;
    }),
    reset() {
      this.adapter = undefined;
      this.onInspect = undefined;
      this.mountCandleChart.mockClear();
      this.mountCandleChart.mockImplementation((container: HTMLElement, options: { onInspect: (candle: Candle | null) => void }) => {
        void container;
        chartPort.onInspect = options.onInspect;
        chartPort.adapter = {
          setCandles: vi.fn(),
          inspect: vi.fn(),
          dispose: vi.fn(),
        };
        return chartPort.adapter;
      });
    },
  };
});

vi.mock("../chart/adapter", () => ({
  mountCandleChart: chartPort.mountCandleChart,
}));

function candle(timeMs: number, closeTicks: number): Candle {
  return {
    timeMs,
    openTicks: closeTicks - 25,
    highTicks: closeTicks + 50,
    lowTicks: closeTicks - 75,
    closeTicks,
    volumeLots: 12_345,
    rev: 1,
    closed: false,
  };
}

function snapshot(overrides: Partial<MarketRuntimeSnapshot> = {}): MarketRuntimeSnapshot {
  const base = createInitialSnapshot(overrides.selectedInterval ?? "1m");
  return {
    ...base,
    session: "session-1",
    symbol: "BTC-USD",
    selectedInterval: overrides.selectedInterval ?? base.selectedInterval,
    meta: {
      ...base.meta,
      status: "ready",
      value: {
        session: "session-1",
        symbol: "BTC-USD",
        tickSize: "0.01",
        lotSize: "0.0001",
        intervals: ["1s", "1m", "5m"],
        referencePriceTicks: 10_000,
        tierPolicy: {
          initialTier: "full",
          flushMs: { full: 50, degraded: 250, minimal: 1000 },
          enterDegraded: { latencyAboveMs: 200, jitterAboveMs: 80 },
          enterMinimal: { latencyAboveMs: 800, jitterAboveMs: 250 },
          recoverFull: { latencyBelowMs: 120, jitterBelowMs: 40 },
          recoverDegraded: { latencyBelowMs: 400, jitterBelowMs: 120 },
          downgradeDwellMs: 1000,
          upgradeDwellMs: 3000,
          missingReportStepMs: 1000,
          missingReportMinimalMs: 4000,
          pingEveryMs: 1000,
          pongTimeoutMs: 800,
          reportEveryMs: 1000,
          rttWindowSamples: 8,
          minimumReportSamples: 3,
          hiddenCloseMs: 10_000,
        },
        retention: {
          historyCandles: { "1s": 120, "1m": 120, "5m": 120 },
          deliveryClosedCandles: 120,
          recentTrades: 80,
          bookChanges: 200,
          maximumBookLevelsPerSide: 20,
        },
      },
      ...overrides.meta,
    },
    candles: {
      ...base.candles,
      status: "ready",
      historyStatus: "ready",
      interval: overrides.selectedInterval ?? base.selectedInterval,
      requestId: 1,
      candles: [candle(1_000, 10_000), candle(2_000, 10_050)],
      ...overrides.candles,
    },
    freshness: {
      ...base.freshness,
      condition: "live",
      ...overrides.freshness,
    },
    ...overrides,
  };
}

async function waitForChartMount() {
  await waitFor(() => expect(chartPort.mountCandleChart).toHaveBeenCalled());
}

afterEach(() => {
  cleanup();
  chartPort.reset();
});

describe("MarketChart", () => {
  it("moves interval focus with ArrowRight without selecting the focused interval", async () => {
    const onSelectInterval = vi.fn<(interval: Interval) => void>();
    render(<MarketChart snapshot={snapshot({ selectedInterval: "1s" })} onSelectInterval={onSelectInterval} />);
    const intervalGroup = screen.getByRole("radiogroup", { name: "Chart interval" });
    const oneSecond = within(intervalGroup).getByRole("radio", { name: "1s" });
    const oneMinute = within(intervalGroup).getByRole("radio", { name: "1m" });
    oneSecond.focus();

    fireEvent.keyDown(oneSecond, { key: "ArrowRight" });

    await waitFor(() => expect(document.activeElement).toBe(oneMinute));
    expect(onSelectInterval).not.toHaveBeenCalled();
    expect(oneSecond.getAttribute("aria-checked")).toBe("true");
    expect(oneMinute.getAttribute("aria-checked")).toBe("false");
  });

  it("selects the clicked interval", () => {
    const onSelectInterval = vi.fn<(interval: Interval) => void>();
    render(<MarketChart snapshot={snapshot({ selectedInterval: "1s" })} onSelectInterval={onSelectInterval} />);
    const oneMinute = within(screen.getByRole("radiogroup", { name: "Chart interval" })).getByRole("radio", { name: "1m" });

    fireEvent.click(oneMinute);

    expect(onSelectInterval).toHaveBeenCalledWith("1m");
  });

  it("shows a visible chart error when mounting the chart renderer fails", async () => {
    chartPort.mountCandleChart.mockImplementation(() => {
      throw new Error("renderer unavailable");
    });

    render(<MarketChart snapshot={snapshot()} onSelectInterval={vi.fn()} />);

    expect(await screen.findByText("Chart unavailable")).toBeTruthy();
  });

  it("shows a visible chart error when updating chart candles fails", async () => {
    const { rerender } = render(<MarketChart snapshot={snapshot()} onSelectInterval={vi.fn()} />);
    await waitForChartMount();
    chartPort.adapter?.setCandles.mockImplementation(() => {
      throw new Error("update failed");
    });

    rerender(<MarketChart snapshot={snapshot({
      candles: {
        ...createInitialSnapshot("1m").candles,
        status: "ready",
        historyStatus: "ready",
        interval: "1m",
        requestId: 1,
        candles: [candle(3_000, 10_100)],
      },
    })} onSelectInterval={vi.fn()} />);

    expect(await screen.findByText("Chart unavailable")).toBeTruthy();
  });

  it("applies the latest candles after the chart adapter import finishes", async () => {
    const first = snapshot({ candles: { ...createInitialSnapshot("1m").candles, status: "ready", historyStatus: "ready", interval: "1m", requestId: 1, candles: [] } });
    const latestCandles = [candle(3_000, 10_100)];
    const { rerender } = render(<MarketChart snapshot={first} onSelectInterval={vi.fn()} />);

    rerender(<MarketChart snapshot={snapshot({
      candles: {
        ...first.candles,
        candles: latestCandles,
      },
    })} onSelectInterval={vi.fn()} />);
    await waitForChartMount();

    await waitFor(() => expect(chartPort.adapter?.setCandles).toHaveBeenLastCalledWith(latestCandles, false));
  });

  it("disables inspection controls when there are no candles", () => {
    render(<MarketChart snapshot={snapshot({
      candles: {
        ...createInitialSnapshot("1m").candles,
        status: "ready",
        historyStatus: "ready",
        interval: "1m",
        requestId: 1,
        candles: [],
      },
    })} onSelectInterval={vi.fn()} />);

    expect((screen.getByRole("button", { name: "Previous candle" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Next candle" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears inspected candle values when a new session replaces the data set", async () => {
    const firstCandles = [candle(1_000, 10_000), candle(2_000, 10_050)];
    const secondCandles = [candle(3_000, 10_300)];
    const { rerender } = render(<MarketChart snapshot={snapshot({
      session: "session-1",
      candles: { ...createInitialSnapshot("1m").candles, status: "ready", historyStatus: "ready", interval: "1m", requestId: 1, candles: firstCandles },
    })} onSelectInterval={vi.fn()} />);
    await waitForChartMount();

    act(() => {
      chartPort.onInspect?.(firstCandles[0]);
    });
    rerender(<MarketChart snapshot={snapshot({
      session: "session-2",
      candles: { ...createInitialSnapshot("1m").candles, status: "ready", historyStatus: "ready", interval: "1m", requestId: 2, candles: secondCandles },
    })} onSelectInterval={vi.fn()} />);

    expect(screen.getByText("Latest candle")).toBeTruthy();
    expect(screen.getByText("103.00")).toBeTruthy();
  });

  it("clears inspected candle values when the interval changes", async () => {
    const firstCandles = [candle(1_000, 10_000), candle(2_000, 10_050)];
    const secondCandles = [candle(3_000, 10_300)];
    const { rerender } = render(<MarketChart snapshot={snapshot({
      selectedInterval: "1m",
      candles: { ...createInitialSnapshot("1m").candles, status: "ready", historyStatus: "ready", interval: "1m", requestId: 1, candles: firstCandles },
    })} onSelectInterval={vi.fn()} />);
    await waitForChartMount();
    act(() => {
      chartPort.onInspect?.(firstCandles[0]);
    });
    chartPort.adapter?.inspect.mockClear();

    rerender(<MarketChart snapshot={snapshot({
      selectedInterval: "5m",
      candles: { ...createInitialSnapshot("5m").candles, status: "ready", historyStatus: "ready", interval: "5m", requestId: 2, candles: secondCandles },
    })} onSelectInterval={vi.fn()} />);

    await waitFor(() => expect(chartPort.adapter?.inspect).toHaveBeenLastCalledWith(null));
    expect(screen.getByText("Latest candle")).toBeTruthy();
    expect(screen.getByText("103.00")).toBeTruthy();
  });

  it("updates inspected candle values when the selected candle key receives revised data", async () => {
    const firstCandles = [candle(1_000, 10_000), candle(2_000, 10_050)];
    const revisedCandles = [candle(1_000, 10_200), candle(2_000, 10_050)];
    const { rerender } = render(<MarketChart snapshot={snapshot({
      candles: { ...createInitialSnapshot("1m").candles, status: "ready", historyStatus: "ready", interval: "1m", requestId: 1, candles: firstCandles },
    })} onSelectInterval={vi.fn()} />);
    await waitForChartMount();
    act(() => {
      chartPort.onInspect?.(firstCandles[0]);
    });

    rerender(<MarketChart snapshot={snapshot({
      candles: { ...createInitialSnapshot("1m").candles, status: "ready", historyStatus: "ready", interval: "1m", requestId: 1, candles: revisedCandles },
    })} onSelectInterval={vi.fn()} />);

    expect(screen.getByText("Inspecting candle")).toBeTruthy();
    expect(screen.getByText("102.00")).toBeTruthy();
  });
});
