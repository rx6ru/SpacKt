import type { Candle, Level, Trade } from "../domain/model";
import type { Meta } from "../domain/market-view";

const fallbackPriceDecimals = 2;
const fallbackLotDecimals = 4;

export function decimalPlaces(step: string | null | undefined, fallback: number): number {
  if (!step || !step.includes(".")) return fallback;
  return step.split(".")[1]?.replace(/0+$/, "").length ?? fallback;
}

export function formatPriceTicks(value: number | null | undefined, meta: Meta | null): string {
  if (value === null || value === undefined) return "-";
  const decimals = decimalPlaces(meta?.tickSize, fallbackPriceDecimals);
  return formatScaled(value, decimals, true);
}

export function formatLots(value: number | null | undefined, meta: Meta | null): string {
  if (value === null || value === undefined) return "-";
  const decimals = decimalPlaces(meta?.lotSize, fallbackLotDecimals);
  return formatScaled(value, decimals, false);
}

export function formatCandle(candle: Candle | null, meta: Meta | null): string {
  if (!candle) return "UTC -  O -  H -  L -  C -  V -";
  return `${formatUTC(candle.timeMs)} UTC  O ${formatPriceTicks(candle.openTicks, meta)}  H ${formatPriceTicks(candle.highTicks, meta)}  L ${formatPriceTicks(candle.lowTicks, meta)}  C ${formatPriceTicks(candle.closeTicks, meta)}  V ${formatLots(candle.volumeLots, meta)}`;
}

export function formatUTC(timeMs: number | null | undefined): string {
  if (timeMs === null || timeMs === undefined) return "-";
  return new Date(timeMs).toISOString().slice(11, 19);
}

export function formatStatusTime(timeMs: number | null | undefined): string {
  if (timeMs === null || timeMs === undefined) return "-";
  return `${formatUTC(timeMs)} UTC`;
}

export function formatRateFromFlush(flushMs: number | null | undefined): string {
  if (!flushMs || flushMs <= 0) return "-";
  const rate = 1000 / flushMs;
  return `${Number.isInteger(rate) ? rate.toFixed(0) : rate.toFixed(1)}/s`;
}

export function formatObserved(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${value.toFixed(1)}/s`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${Math.round(value)} ms`;
}

export function formatSeconds(valueMs: number | null | undefined): string {
  if (valueMs === null || valueMs === undefined) return "-";
  return `${(valueMs / 1000).toFixed(valueMs % 1000 === 0 ? 0 : 1)} s`;
}

export function latestTrade(trades: Trade[] | null | undefined): Trade | null {
  return trades?.[0] ?? null;
}

export function latestCandle(candles: readonly Candle[]): Candle | null {
  return candles.length === 0 ? null : candles[candles.length - 1] ?? null;
}

export function spreadTicks(bids: readonly Level[], asks: readonly Level[]): number | null {
  if (bids.length === 0 || asks.length === 0) return null;
  return asks[0].priceTicks - bids[0].priceTicks;
}

function formatScaled(value: number, decimals: number, group: boolean): string {
  const scale = 10 ** decimals;
  const numberValue = value / scale;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: group,
  }).format(numberValue);
}
