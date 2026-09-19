import type { Trade } from "../domain/model";

export type RecentTradesState = {
  session: string | null;
  trades: Trade[];
  latestPriceTicks: number | null;
  latestTradeId: number | null;
};

const MAX_TRADES = 100;
const cloneTrade = (trade: Trade): Trade => ({ ...trade });

export class RecentTrades {
  private session: string | null = null;
  private tradesById = new Map<number, Trade>();
  private latestPriceTicks: number | null = null;
  private latestTradeId: number | null = null;

  merge(session: string, trades: Trade[]): void {
    if (this.session === null) {
      this.session = session;
    }

    if (session !== this.session) {
      return;
    }

    for (const trade of trades) {
      if (this.tradesById.has(trade.id)) {
        continue;
      }

      this.tradesById.set(trade.id, cloneTrade(trade));
      if (this.latestTradeId === null || trade.id > this.latestTradeId) {
        this.latestTradeId = trade.id;
        this.latestPriceTicks = trade.priceTicks;
      }
    }

    this.trimTrades();
  }

  reset(session: string): void {
    this.session = session;
    this.tradesById.clear();
    this.latestPriceTicks = null;
    this.latestTradeId = null;
  }

  getState(): RecentTradesState {
    return {
      session: this.session,
      trades: this.sortedTrades(),
      latestPriceTicks: this.latestPriceTicks,
      latestTradeId: this.latestTradeId,
    };
  }

  private sortedTrades(): Trade[] {
    return Array.from(this.tradesById.values())
      .sort((left, right) => right.id - left.id)
      .map(cloneTrade);
  }

  private trimTrades(): void {
    const sorted = this.sortedTrades();
    for (const trade of sorted.slice(MAX_TRADES)) {
      this.tradesById.delete(trade.id);
    }
  }
}
