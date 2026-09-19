import { decodeWire } from "./wire/schema";

export type FetchOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
};

export async function fetchWire(
  _kind: Parameters<typeof decodeWire>[0],
  _url: string,
  _options: FetchOptions = {},
): Promise<Record<string, unknown>> {
  throw new Error("Not implemented");
}
