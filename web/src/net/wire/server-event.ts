import type { ServerEvent } from "../../domain/events";
import { mapServerEvent } from "./mapping";
import { decodeWire } from "./schema";
import {
  assertByteLimit,
  assertJsonDepth,
  type WireRecord,
} from "./support";

export class ProtocolVersionError extends Error {
  constructor(readonly receivedVersion: number) {
    super(`Unsupported protocol version: ${receivedVersion}`);
    this.name = "ProtocolVersionError";
  }
}

export function decodeServerEvent(raw: string, phase: "hello" | "active"): ServerEvent {
  try {
    return mapDecodedServerEvent(decodeWire("server", raw), phase, raw);
  } catch (error) {
    const unsupportedVersion = maybeUnsupportedHelloVersion(raw, phase);
    if (unsupportedVersion !== null) {
      throw new ProtocolVersionError(unsupportedVersion);
    }
    throw error;
  }
}

function mapDecodedServerEvent(value: WireRecord, phase: "hello" | "active", raw: string): ServerEvent {
  if (phase === "hello" && value.type !== "hello") {
    throw new Error("first server message must be hello");
  }
  if (phase === "active" && value.type === "hello") {
    throw new Error("duplicate hello message");
  }

  return mapServerEvent(value, byteLength(raw));
}

function maybeUnsupportedHelloVersion(raw: string, phase: "hello" | "active"): number | null {
  if (phase !== "hello") {
    return null;
  }

  assertByteLimit("server", raw);
  assertJsonDepth(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isWireObject(parsed) || parsed.type !== "hello") {
    return null;
  }

  const version = parsed.v;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return null;
  }

  return version === 1 ? null : version;
}

function isWireObject(value: unknown): value is WireRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(raw: string): number {
  return new TextEncoder().encode(raw).byteLength;
}
