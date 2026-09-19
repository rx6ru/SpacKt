import type { ServerEvent } from "../../domain/events";

export class ProtocolVersionError extends Error {
  constructor(readonly receivedVersion: number) {
    super(`Unsupported protocol version: ${receivedVersion}`);
    this.name = "ProtocolVersionError";
  }
}

export function decodeServerEvent(raw: string, phase: "hello" | "active"): ServerEvent {
  void raw;
  void phase;
  throw new Error("Not implemented: decodeServerEvent");
}
