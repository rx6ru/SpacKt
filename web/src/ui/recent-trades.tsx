import type { MarketRuntimeSnapshot } from "../domain/market-view";
import { formatLots, formatPriceTicks, formatUTC } from "./format";

export function RecentTrades({ snapshot }: { snapshot: MarketRuntimeSnapshot }) {
  const meta = snapshot.meta.value;
  const trades = snapshot.trades.value?.trades.slice(0, 20) ?? [];

  return (
    <section className="panel trades-panel" aria-label="Recent trades">
      <div className="panel-heading">
        <div>
          <h2>Recent trades</h2>
          <p>Newest first</p>
        </div>
      </div>
      <div className="trade-table" role="table" aria-label="Recent trades table">
        <div className="trade-row table-head" role="row">
          <span role="columnheader">Time</span>
          <span role="columnheader">Price</span>
          <span role="columnheader">Size</span>
          <span role="columnheader">Side</span>
        </div>
        {snapshot.trades.skippedDisplayRecords > 0 ? (
          <div className="trade-row skipped" role="row">
            <span role="cell" className="full-row">
              Earlier records outside this list: {snapshot.trades.skippedDisplayRecords}
            </span>
          </div>
        ) : null}
        {trades.length === 0 ? (
          <div className="trade-row" role="row">
            <span role="cell" className="full-row">No trades received yet.</span>
          </div>
        ) : trades.map((trade) => (
          <div className="trade-row" role="row" key={trade.id}>
            <span role="cell" className="numeric">{formatUTC(trade.timeMs)}</span>
            <span role="cell" className="numeric">{formatPriceTicks(trade.priceTicks, meta)}</span>
            <span role="cell" className="numeric">{formatLots(trade.quantityLots, meta)}</span>
            <span role="cell" className={trade.side === "buy" ? "buy-text" : "sell-text"}>
              {trade.side.toUpperCase() === "BUY" ? "BUY" : "SELL"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
