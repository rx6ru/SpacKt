export type Trade = {
  id: number;
  timeMs: number;
  priceTicks: number;
  quantityLots: number;
  side: string;
};

export type Interval = "1s" | "1m" | "5m";
export type Level = {priceTicks: number; quantityLots: number};
export type Candle = {timeMs: number; openTicks: number; highTicks: number; lowTicks: number; closeTicks: number; volumeLots: number; rev: number; closed: boolean};
