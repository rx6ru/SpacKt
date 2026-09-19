import type {
  BookSnapshotDomain,
  HistoryDomain,
  HttpErrorEnvelope,
  Meta,
  RecentTradesDomain,
  ServerEvent,
} from "../../domain/events";
import type { WireRecord } from "./support";

export type {
  BookResetEvent,
  BookSnapshotDomain,
  CandlesResetEvent,
  DebugCommand,
  DurationByTier,
  EntryThresholds,
  HeartbeatEvent,
  HelloEvent,
  HistoryDomain,
  HttpErrorEnvelope,
  Meta,
  PongEvent,
  RecentTradesDomain,
  RecoveryThresholds,
  RetentionPolicy,
  ServerErrorEvent,
  ServerEvent,
  SubscribedEvent,
  Symbol,
  Tier,
  TierEvent,
  TierPolicy,
  UpdateEvent,
} from "../../domain/events";

export function mapMeta(_value: WireRecord): Meta {
  void _value;
  throw new Error("Not implemented: mapMeta");
}

export function mapBookSnapshot(_value: WireRecord): BookSnapshotDomain {
  void _value;
  throw new Error("Not implemented: mapBookSnapshot");
}

export function mapHistory(_value: WireRecord): HistoryDomain {
  void _value;
  throw new Error("Not implemented: mapHistory");
}

export function mapRecentTrades(_value: WireRecord): RecentTradesDomain {
  void _value;
  throw new Error("Not implemented: mapRecentTrades");
}

export function mapServerEvent(_value: WireRecord, _wireBytes: number): ServerEvent {
  void _value;
  void _wireBytes;
  throw new Error("Not implemented: mapServerEvent");
}

export function mapHttpError(_value: WireRecord): HttpErrorEnvelope {
  void _value;
  throw new Error("Not implemented: mapHttpError");
}
