import * as z from "zod/mini";

const textEncoder = new TextEncoder();

export const maxSafeUint = Number.MAX_SAFE_INTEGER;
export const maxClientBytes = 4096;
export const maxSocketBytes = 1024 * 1024;
export const maxRestBytes = 2 * 1024 * 1024;
export const maxDepth = 12;

export const intervals = ["1s", "1m", "5m"] as const;
export const tiers = ["full", "degraded", "minimal"] as const;
export const tradeSides = ["buy", "sell"] as const;
export const errorCodes = [
  "bad_request",
  "not_found",
  "method_not_allowed",
  "not_ready",
  "busy",
  "origin_denied",
  "rate_limited",
  "internal_error",
  "bad_message",
  "unknown_interval",
  "bad_request_id",
  "wrong_session",
  "debug_disabled",
  "capacity_reached",
] as const;

export type WireRecord = Record<string, unknown>;
export type Interval = (typeof intervals)[number];
export type Tier = (typeof tiers)[number];
export type ErrorCode = (typeof errorCodes)[number];
export type SchemaKind =
  | "meta"
  | "book"
  | "history"
  | "trades"
  | "httpError"
  | "health"
  | "readiness"
  | "client"
  | "server";

export type DecimalParts = {
  raw: string;
  scaled: number;
};

export const topLevelKinds = new Set<SchemaKind>([
  "meta",
  "book",
  "history",
  "trades",
  "httpError",
  "health",
  "readiness",
  "client",
  "server",
]);

export function parseKind(kind: string): SchemaKind {
  if (topLevelKinds.has(kind as SchemaKind)) {
    return kind as SchemaKind;
  }
  throw new Error(`unknown wire kind: ${kind}`);
}

export function expectSessionSymbol(value: unknown, extraKeys: string[]): WireRecord {
  const object = expectObject(value, ["session", "symbol", ...extraKeys]);
  return {
    ...object,
    session: expectSessionId(object.session, "session"),
    symbol: expectSymbol(object.symbol),
  };
}

export function expectObjectWithType(value: unknown): WireRecord {
  const object = expectPlainObject(value);
  if (typeof object.type !== "string" || typeof object.session !== "string") {
    throw new Error("invalid message envelope");
  }
  return object;
}

export function expectObject(value: unknown, keys: string[]): WireRecord {
  return parseStrictObject(value, Object.fromEntries(keys.map((key) => [key, z.unknown()])));
}

export function expectObjectAllowOptional(value: unknown, requiredKeys: string[], optionalKeys: string[]): WireRecord {
  const shape = Object.fromEntries([
    ...requiredKeys.map((key) => [key, z.unknown()] as const),
    ...optionalKeys.map((key) => [key, z.optional(z.unknown())] as const),
  ]);
  return parseStrictObject(value, shape);
}

export function expectPlainObject(value: unknown): WireRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as WireRecord;
}

export function expectArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected array: ${name}`);
  }
  return value;
}

export function expectSafeUint(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maxSafeUint) {
    throw new Error(`invalid safe uint: ${name}`);
  }
  return value;
}

export function expectPositiveId(value: unknown, name: string): number {
  return expectBoundedSafeUint(value, name, 1, maxSafeUint);
}

export function expectNullablePositiveId(value: unknown, name: string): number | null {
  return value === null ? null : expectPositiveId(value, name);
}

export function expectBoundedSafeUint(value: unknown, name: string, min: number, max: number): number {
  const safe = expectSafeUint(value, name);
  if (safe < min || safe > max) {
    throw new Error(`invalid bounds: ${name}`);
  }
  return safe;
}

export function expectDuration(value: unknown, name: string): number {
  return expectBoundedSafeUint(value, name, 1, 3_600_000);
}

export function expectFiniteNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`invalid number: ${name}`);
  }
  return value;
}

export function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`invalid boolean: ${name}`);
  }
  return value;
}

export function expectOneOf<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`invalid enum: ${name}`);
  }
  return value;
}

export function expectInterval(value: unknown, name: string): Interval {
  return expectOneOf(value, intervals, name);
}

export function expectTier(value: unknown, name: string): Tier {
  return expectOneOf(value, tiers, name);
}

export function expectNullableTier(value: unknown, name: string): Tier | null {
  return value === null ? null : expectTier(value, name);
}

export function expectErrorCode(value: unknown, name: string): ErrorCode {
  return expectOneOf(value, errorCodes, name);
}

export function expectSessionId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(`invalid id: ${name}`);
  }
  return value;
}

export function expectSymbol(value: unknown): "BTC-USD" {
  return expectExactString(value, "BTC-USD", "symbol") as "BTC-USD";
}

export function expectDisplayText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`invalid display text: ${name}`);
  }
  const codePointLength = Array.from(value).length;
  if (codePointLength < 1 || codePointLength > 160 || byteLength(value) > 640 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid display text: ${name}`);
  }
  return value;
}

export function expectExactString(value: unknown, expected: string, name: string): string {
  if (value !== expected) {
    throw new Error(`invalid string: ${name}`);
  }
  return expected;
}

export function expectExactNumber(value: unknown, expected: number, name: string): number {
  if (value !== expected) {
    throw new Error(`invalid number: ${name}`);
  }
  return expected;
}

export function validateDurationMap(value: unknown, name: string): { full: number; degraded: number; minimal: number } {
  const object = expectObject(value, ["full", "degraded", "minimal"]);
  return {
    full: expectDuration(object.full, `${name}.full`),
    degraded: expectDuration(object.degraded, `${name}.degraded`),
    minimal: expectDuration(object.minimal, `${name}.minimal`),
  };
}

export function validateThresholds<A extends string, B extends string>(value: unknown, firstKey: A, secondKey: B): Record<A | B, number> {
  const object = expectObject(value, [firstKey, secondKey]);
  return {
    [firstKey]: expectDuration(object[firstKey], firstKey),
    [secondKey]: expectDuration(object[secondKey], secondKey),
  } as Record<A | B, number>;
}

export function parsePrice(value: unknown): DecimalParts {
  return parseDecimal(value, "price", 2, 16, true);
}

export function parseQuantity(value: unknown, positive: boolean): DecimalParts {
  return parseDecimal(value, "quantity", 4, 18, positive);
}

export function assertByteLimit(kind: SchemaKind, raw: string): void {
  const limit = kind === "client" ? maxClientBytes : kind === "server" ? maxSocketBytes : maxRestBytes;
  if (byteLength(raw) > limit) {
    throw new Error("wire byte limit exceeded");
  }
}

export function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function assertJsonDepth(raw: string): void {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (const char of raw) {
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      if (depth > maxDepth) {
        throw new Error("JSON depth limit exceeded");
      }
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
}

export function assertJsonSafe(value: unknown, seen = new WeakSet<object>()): void {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error("value cannot be encoded as JSON");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("nonfinite number cannot be encoded");
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    throw new Error("cyclic value cannot be encoded");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonSafe(item, seen);
    }
  } else {
    for (const item of Object.values(value as WireRecord)) {
      assertJsonSafe(item, seen);
    }
  }
  seen.delete(value);
}

function parseStrictObject(value: unknown, shape: Record<string, z.ZodMiniType>): WireRecord {
  const result = z.strictObject(shape).safeParse(value);
  if (!result.success) {
    throw new Error("invalid object shape");
  }
  return result.data as WireRecord;
}

function parseDecimal(value: unknown, name: string, scale: number, maxLength: number, positive: boolean): DecimalParts {
  if (typeof value !== "string" || value.length > maxLength || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(`invalid decimal: ${name}`);
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > scale) {
    throw new Error(`invalid decimal precision: ${name}`);
  }

  const scaledText = whole + fraction.padEnd(scale, "0");
  const scaled = Number(scaledText);
  if (!Number.isSafeInteger(scaled) || (positive ? scaled <= 0 : scaled < 0)) {
    throw new Error(`invalid decimal bounds: ${name}`);
  }

  return { raw: value, scaled };
}
