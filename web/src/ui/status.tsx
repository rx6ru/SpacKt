import { ReloadIcon } from "@radix-ui/react-icons";
import type { MarketRuntimeSnapshot } from "../domain/market-view";
import { formatMs, formatObserved, formatRateFromFlush } from "./format";

type StatusProps = {
  snapshot: MarketRuntimeSnapshot;
  onRetry: () => void;
};

export function ConnectionStatus({ snapshot, onRetry }: StatusProps) {
  const status = statusLabel(snapshot);
  const measurement = snapshot.telemetry.measurement;
  const showReload = snapshot.reloadRequired;
  const showRetry = !showReload && (snapshot.manualRetryRequired || snapshot.connection.status === "terminal");

  return (
    <section className="status-strip" aria-label="Connection and delivery">
      <div className="status-live" aria-live="polite">
        <span className={`status-dot ${status.toLowerCase().replaceAll(" ", "-")}`} aria-hidden="true" />
        <span className="status-label">Connection</span>{" "}
        <strong>{status}</strong>
      </div>
      <Metric label="Tier" value={snapshot.tier.effective ?? "-"} />
      <Metric label="Configured target" value={formatRateFromFlush(snapshot.tier.flushMs)} />
      <Metric label="Observed" value={formatObserved(snapshot.observedRate.valuePerSecond)} />
      <Metric label="RTT" value={formatMs(measurement?.latencyMs)} />
      <Metric label="Jitter" value={formatMs(measurement?.jitterMs)} />
      {snapshot.cachedStale || snapshot.freshness.condition === "stale" ? (
        <span className="state-copy">Cached values</span>
      ) : null}
      {snapshot.freshness.condition === "feed-delayed" ? <span className="state-copy">Market feed delayed</span> : null}
      {showRetry ? (
        <button className="compact-action" type="button" onClick={onRetry}>
          <ReloadIcon aria-hidden="true" />
          Retry
        </button>
      ) : null}
      {showReload ? (
        <button className="compact-action" type="button" onClick={() => window.location.reload()}>
          <ReloadIcon aria-hidden="true" />
          Reload
        </button>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="status-metric">
      <span>{label}</span>{" "}
      <strong>{value}</strong>
    </span>
  );
}

function statusLabel(snapshot: MarketRuntimeSnapshot): string {
  if (snapshot.reloadRequired) return "Reload required";
  if (snapshot.manualRetryRequired) return "Recovery failed";
  if (!snapshot.connection.online) return "Offline";
  if (snapshot.connection.status === "reconnecting") {
    return snapshot.connection.reconnectAttempts > 0 ? `Reconnecting (attempt ${snapshot.connection.reconnectAttempts})` : "Reconnecting";
  }
  if (snapshot.connection.status === "connecting") return "Connecting";
  if (snapshot.freshness.condition === "feed-delayed") return "Feed delayed";
  if (snapshot.cachedStale || snapshot.freshness.condition === "stale") return "Stale";
  if (snapshot.liveEligible) return "Live";
  if (snapshot.freshness.condition === "waiting" && snapshot.meta.status === "ready") return "Waiting for market";
  return "Syncing feed";
}
