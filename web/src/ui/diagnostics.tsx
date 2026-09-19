"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Cross2Icon, HamburgerMenuIcon } from "@radix-ui/react-icons";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useEffect, useRef, useState } from "react";
import type { DebugCommand, MarketRuntimeSnapshot, Tier } from "../domain/market-view";
import { formatMs, formatObserved, formatRateFromFlush, formatSeconds } from "./format";

type DiagnosticsProps = {
  snapshot: MarketRuntimeSnapshot;
  onDebug: (command: DebugCommand) => void;
  onRetry: () => void;
};

export function DiagnosticsDrawer({ snapshot, onDebug, onRetry }: DiagnosticsProps) {
  const [open, setOpen] = useState(false);
  const [pongDelay, setPongDelay] = useState("0");
  const [cooldownActive, setCooldownActive] = useState(false);
  const cooldownRef = useRef<number | null>(null);
  const disabled = cooldownActive || snapshot.connection.status !== "live";
  const summary = <DiagnosticsSummary snapshot={snapshot} />;

  useEffect(() => {
    return () => {
      if (cooldownRef.current !== null) {
        window.clearTimeout(cooldownRef.current);
      }
    };
  }, []);

  function runDebug(command: DebugCommand) {
    if (disabled) return;
    onDebug(command);
    setCooldownActive(true);
    if (cooldownRef.current !== null) {
      window.clearTimeout(cooldownRef.current);
    }
    cooldownRef.current = window.setTimeout(() => {
      cooldownRef.current = null;
      setCooldownActive(false);
    }, 1000);
  }

  const controls = (
    <div className="diagnostics-grid">
      {summary}
      <div className="debug-section full-line">
        <span id="force-tier-label">Force delivery tier</span>
        <ToggleGroup.Root
          aria-labelledby="force-tier-label"
          className="segmented wrap"
          type="single"
          value={snapshot.tier.forced ?? "auto"}
          onValueChange={(value) => {
            if (value) runDebug({ action: "forceTier", value: value as Tier | "auto" });
          }}
        >
          {(["auto", "full", "degraded", "minimal"] as const).map((value) => (
            <ToggleGroup.Item
              key={value}
              aria-label={labelForTier(value)}
              className="segment"
              disabled={disabled}
              value={value}
            >
              {labelForTier(value)}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
      </div>
      <div className="debug-section">
        <label htmlFor="pong-delay">Pong delay</label>
        <input
          id="pong-delay"
          className="number-input"
          type="number"
          min="0"
          max="4000"
          step="100"
          disabled={disabled}
          value={pongDelay}
          onChange={(event) => setPongDelay(event.target.value)}
        />
        <button
          type="button"
          className="control-button"
          disabled={disabled}
          onClick={() => runDebug({ action: "pongDelay", value: boundedDelay(pongDelay) })}
        >
          Apply pong delay
        </button>
      </div>
      <button
        type="button"
        className="control-button"
        disabled={disabled}
        onClick={() => runDebug({ action: "dropNextBookDelta" })}
      >
        Drop next book delta
      </button>
      <button
        type="button"
        className="control-button danger"
        disabled={disabled}
        onClick={() => runDebug({ action: "disconnect" })}
      >
        Disconnect this session
      </button>
      {snapshot.manualRetryRequired ? (
        <button type="button" className="control-button" onClick={onRetry}>Retry</button>
      ) : null}
    </div>
  );

  return (
    <section className="panel diagnostics-panel" aria-label="Diagnostics and debug controls">
      <div className="panel-heading">
        <div>
          <h2>Diagnostics</h2>
          <p>Connection details and test controls</p>
        </div>
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger asChild>
            <button type="button" className="compact-action">
              <HamburgerMenuIcon aria-hidden="true" />
              Open diagnostics
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog-content" aria-label="Diagnostics and debug controls">
              <Dialog.Title>Diagnostics and debug controls</Dialog.Title>
              <Dialog.Description className="dialog-description">
                These controls affect only this browser connection.
              </Dialog.Description>
              {controls}
              <Dialog.Close asChild>
                <button type="button" className="dialog-close" aria-label="Close diagnostics">
                  <Cross2Icon aria-hidden="true" />
                </button>
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </section>
  );
}

function DiagnosticsSummary({ snapshot }: { snapshot: MarketRuntimeSnapshot }) {
  const measurement = snapshot.telemetry.measurement;

  return (
    <>
      <Diagnostic label="Active tier" value={snapshot.tier.effective ?? "unavailable"} />
      <Diagnostic label="Auto tier" value={snapshot.tier.auto ?? "unavailable"} />
      <Diagnostic label="Forced tier" value={snapshot.tier.forced ?? "auto"} />
      <Diagnostic label="Configured target" value={valueOrUnavailable(formatRateFromFlush(snapshot.tier.flushMs))} />
      <Diagnostic label="Observed" value={`${formatObserved(snapshot.observedRate.valuePerSecond)} over ${formatSeconds(snapshot.observedRate.windowMs)}`} />
      <Diagnostic label="Latency" value={valueOrUnavailable(formatMs(measurement?.latencyMs))} />
      <Diagnostic label="Jitter" value={valueOrUnavailable(formatMs(measurement?.jitterMs))} />
      <Diagnostic label="Recent ping timeouts" value={String(snapshot.telemetry.timedOutIds.length)} />
      <Diagnostic label="Measured RTT samples" value={String(measurement?.samples ?? 0)} />
      <Diagnostic label="Last server reason" value={snapshot.tier.reason ?? "unavailable"} />
      <Diagnostic label="Raw transport state" value={snapshot.connection.status} />
      <Diagnostic label="Raw session ID" value={snapshot.session ?? "unavailable"} />
      <Diagnostic label="Bad messages" value={String(snapshot.diagnostics.malformedMessages)} />
      {snapshot.book.status === "buffering" ? <p className="full-line state-copy">Book resyncing</p> : null}
      {hasRuntimeRecoveryText(snapshot) ? <p className="full-line state-copy">Runtime recovery active</p> : null}
      {snapshot.tier.forced ? (
        <p className="full-line">Forced {snapshot.tier.forced}. Auto would be {snapshot.tier.auto ?? "-"}.</p>
      ) : null}
      {snapshot.tier.hidden ? <p className="full-line">Hidden tab uses minimal delivery.</p> : null}
    </>
  );
}

function Diagnostic({ label, value }: { label: string; value: string }) {
  return (
    <div className="diagnostic-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function boundedDelay(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(4000, Math.round(parsed)));
}

function valueOrUnavailable(value: string): string {
  return value === "-" ? "unavailable" : value;
}

function labelForTier(value: Tier | "auto"): string {
  switch (value) {
    case "auto":
      return "Auto";
    case "full":
      return "Full";
    case "degraded":
      return "Degraded";
    case "minimal":
      return "Minimal";
  }
}

function hasRuntimeRecoveryText(snapshot: MarketRuntimeSnapshot): boolean {
  return (
    !snapshot.connection.online ||
    snapshot.connection.status === "reconnecting" ||
    snapshot.cachedStale ||
    snapshot.freshness.condition === "stale"
  );
}
