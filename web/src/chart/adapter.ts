import type { Candle } from "../domain/model";

export type CandleChartAdapter = {
  setCandles(candles: readonly Candle[], reset?: boolean): void;
  inspect(timeMs: number | null): void;
  dispose(): void;
};

export function mountCandleChart(
  _container: HTMLElement,
  _options: { onInspect: (candle: Candle | null) => void },
): CandleChartAdapter {
  void _container;
  void _options;
  return {
    setCandles(): void {
      throw new Error("Not implemented");
    },
    inspect(): void {
      throw new Error("Not implemented");
    },
    dispose(): void {
      throw new Error("Not implemented");
    },
  };
}
