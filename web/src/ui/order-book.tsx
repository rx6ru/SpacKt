import type { MarketRuntimeSnapshot } from "../domain/market-view";
import type { Level } from "../domain/model";
import { formatLots, formatPriceTicks, spreadTicks } from "./format";

export function OrderBook({ snapshot }: { snapshot: MarketRuntimeSnapshot }) {
  const meta = snapshot.meta.value;
  const asks = snapshot.book.asks.slice(0, 10);
  const bids = snapshot.book.bids.slice(0, 10);
  const maxQty = Math.max(1, ...asks.map((level) => level.quantityLots), ...bids.map((level) => level.quantityLots));
  const bookStatus = bookStatusText(snapshot);

  return (
    <section className="panel book-panel" aria-label="Order book">
      <div className="panel-heading">
        <div>
          <h2>Order book</h2>
          <p>Book status <strong>{bookStatus}</strong></p>
        </div>
      </div>
      <div className={`book-table ${snapshot.book.status !== "synced" ? "muted-data" : ""}`}>
        <div className="book-row book-head">
          <span>Side</span>
          <span>Price (USD)</span>
          <span>Size (BTC)</span>
          <span>Liquidity</span>
        </div>
        <BookRows side="ASK" levels={[...asks].reverse()} maxQty={maxQty} meta={meta} />
        <div className="spread-row">
          <span>Spread</span>
          <strong>{formatPriceTicks(spreadTicks(bids, asks), meta)}</strong>
          <span>Seq {snapshot.book.expectedSeq ?? "-"}</span>
        </div>
        <BookRows side="BID" levels={bids} maxQty={maxQty} meta={meta} />
      </div>
      {snapshot.book.status === "buffering" ? <p className="state-copy">Book resyncing</p> : null}
      {snapshot.book.status === "failed" ? (
        <p className="state-copy">Book recovery stopped. Use Retry to request a new snapshot.</p>
      ) : null}
    </section>
  );
}

function BookRows({
  side,
  levels,
  maxQty,
  meta,
}: {
  side: "ASK" | "BID";
  levels: Level[];
  maxQty: number;
  meta: MarketRuntimeSnapshot["meta"]["value"];
}) {
  const rows = Array.from({ length: 10 }, (_, index) => levels[index] ?? null);

  return (
    <>
      {rows.map((level, index) => (
        <div className={`book-row ${side.toLowerCase()}`} key={`${side}-${index}`}>
          <span className="side-label">{side}</span>
          <span className="numeric">{formatPriceTicks(level?.priceTicks, meta)}</span>
          <span className="numeric">{formatLots(level?.quantityLots, meta)}</span>
          <span className="depth-track" aria-hidden="true">
            <span style={{ transform: `scaleX(${level ? Math.max(0.04, level.quantityLots / maxQty) : 0})` }} />
          </span>
        </div>
      ))}
    </>
  );
}

function bookStatusText(snapshot: MarketRuntimeSnapshot): string {
  if (snapshot.book.status === "synced") return "synced";
  if (snapshot.book.status === "buffering") return "Book resyncing";
  if (snapshot.book.status === "failed") return "Recovery failed";
  return snapshot.book.status;
}
