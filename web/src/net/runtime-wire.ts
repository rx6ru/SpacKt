import type { ServerEvent } from "../domain/events";
import { fetchWire } from "./http";
import {
  mapBookSnapshot,
  mapHistory,
  mapMeta,
  mapRecentTrades,
} from "./wire/mapping";
import { decodeServerEvent, ProtocolVersionError } from "./wire/server-event";
import { encodeWire } from "./wire/schema";

export { ProtocolVersionError };

export function decodeRuntimeServerEvent(
  raw: string,
  phase: "hello" | "active",
): ServerEvent {
  return decodeServerEvent(raw, phase);
}

export function encodeClientWire(value: unknown): string {
  return encodeWire("client", value);
}

export const mapRuntimeMeta = mapMeta;
export const mapRuntimeBook = mapBookSnapshot;
export const mapRuntimeHistory = mapHistory;
export const mapRuntimeTrades = mapRecentTrades;

export async function fetchRuntimeWire(
  fetcher: typeof fetch,
  kind: Parameters<typeof fetchWire>[0],
  url: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return fetchWire(kind, url, { fetcher, signal });
}
