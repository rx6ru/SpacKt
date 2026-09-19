import * as Tooltip from "@radix-ui/react-tooltip";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import { formatPriceTicks, formatStatusTime, latestTrade } from "./format";

export function PriceHeader({ snapshot }: { snapshot: MarketRuntimeSnapshot }) {
  const meta = snapshot.meta.value;
  const trade = latestTrade(snapshot.trades.value?.trades);
  const latestPrice = snapshot.trades.latestPriceTicks ?? trade?.priceTicks ?? null;
  const reference = meta?.referencePriceTicks ?? null;
  const move = latestPrice !== null && reference !== null ? latestPrice - reference : null;
  const movePercent = move !== null && reference !== null && reference !== 0 ? (move / reference) * 100 : null;
  const latestText = latestPrice === null ? "-" : `$${formatPriceTicks(latestPrice, meta)}`;
  const movementText = move === null ? "-" : `${formatMove(move, meta)} ${formatPercent(movePercent)}`;
  const movementLabel = move === null ? "Movement unavailable"
    : `${move < 0 ? "Down" : "Up"} ${formatMove(move, meta)} and ${formatPercent(movePercent)} from session start`;

  return (
    <section className="market-summary" aria-label="Market summary">
      <div className="brand-lockup" aria-label="SpacKt">
        <span className="spacecat-mark" aria-hidden="true" />
        <span className="brand-word">SpacKt</span>
      </div>
      <div className="summary-primary">
        <span className="symbol">{snapshot.symbol ?? "BTC-USD"}</span>
        <span
          className="latest-price"
          aria-label="Latest price"
        >
          {latestText}
        </span>
        <span
          className={move === null ? "move" : move < 0 ? "move negative" : "move positive"}
          aria-label={movementLabel}
        >
          {movementText}
        </span>
        <span className="summary-note">From session start</span>
      </div>
      <div className="summary-secondary">
        <Tooltip.Provider delayDuration={250}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <span className="reference-price" tabIndex={0} aria-label="Reference price">
                Reference price {formatPriceTicks(reference, meta)} USD
                <span aria-hidden="true" className="info-dot">i</span>
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip-content" sideOffset={6}>
                Movement compares the latest trade with the session-start reference.
                <Tooltip.Arrow className="tooltip-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
        <span>Last trade {formatStatusTime(trade?.timeMs)}</span>
      </div>
    </section>
  );
}

function formatMove(value: number | null, meta: MarketRuntimeSnapshot["meta"]["value"]): string {
  if (value === null) return "-";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${formatPriceTicks(Math.abs(value), meta)}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "-";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}
