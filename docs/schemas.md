# Version 1 wire schemas

Version 1. Go and TypeScript validate the same wire contract.
This document defines exact transmitted shapes. [Protocol](protocol.md) defines their behaviour.
Changes require matching Go and TypeScript fixtures before implementation changes.

## 1. Parsing and object policy

Both receivers decode exactly one UTF-8 JSON object, then validate its known shape.
Reject trailing non-whitespace data, unknown message types, missing fields, wrong types, and unknown fields in every defined object.
Optional fields may be absent; explicit null is permitted only where specified below.

Duplicate JSON member names deliberately use the last complete member value.
This includes nested objects: later objects replace earlier objects, rather than merging fields.
Go first decodes into a fresh generic JSON tree using UseNumber; it does not decode duplicates into an existing typed struct.
The browser first uses JSON.parse. Both then perform strict schema validation and domain conversion.
This policy avoids a custom browser JSON parser while making cross-language behaviour explicit.
It must be tested with raw JSON text, not a fixture already parsed into a map.

Maximum nesting depth is12. Reject deeper input before application processing.
Numeric field checks operate on the decoded IEEE-754 numeric value on both sides.
Go converts json.Number with checked Float64 conversion before safe-integer and finite-value tests, matching the browser.
Encoded IDs are emitted as canonical integer literals; reject decoded nonintegral or unsafe values.
Exact prices and quantities remain decimal strings and never use this numeric path.
Client-to-server WebSocket messages have a4096-byte limit before server parsing.
Server-to-browser WebSocket messages have a one-MiB limit before browser parsing.
The server also checks each outbound market update after UTF-8 encoding and before writing any bytes.
Browser REST responses are bounded to two MiB while reading the body, before decoding.
A declared Content-Length alone is insufficient; count actual bytes.
These are wire-byte bounds, not claims about exact decoded-memory consumption.

## 2. Scalar definitions

| Name | Definition |
|---|---|
| SafeUint | JSON number; integer0 through9007199254740991 |
| PositiveId | SafeUint of at least1 |
| SessionId / ConnectionId |1–64 ASCII characters matching `[A-Za-z0-9_-]+` |
| Symbol | The literal `BTC-USD` for this version |
| Interval | `1s`, `1m`, or `5m` |
| Tier | `full`, `degraded`, or `minimal` |
| Price | Positive decimal string, at most16 characters; at most2 fractional digits; scaled integer must be safe |
| Quantity | Nonnegative decimal string, at most18 characters; at most4 fractional digits; scaled integer must be safe |
| Decimal grammar | Digits before an optional decimal point; if present, at least one fractional digit; no sign, exponent, whitespace, or non-ASCII digits |
| DurationMs | SafeUint; each field also obeys its listed maximum |
| DisplayText |1–160 Unicode characters, at most640 UTF-8 bytes, without control characters |
| ErrorCode | One of the codes enumerated in section5 |

Identifiers are unique within their documented session or connection scope, not globally across all time.
The production generator obeys tighter operational bounds in architecture.md.
Numeric conversion tests may use valid decimal values outside the generator's selected price range.
A model's configuration limits and a decimal parser's representable range are distinct contracts.

## 3. Reused structures

```text
Level = [Price, Quantity]                    // exactly two elements
Trade = {id:PositiveId, t:SafeUint, p:Price, q:Quantity>0, side:"buy"|"sell"}
Candle = {t:SafeUint, o:Price, h:Price, l:Price, c:Price,
          v:Quantity, rev:PositiveId, closed:boolean}
BookRange = {from:PositiveId, to:PositiveId, bids:Level[], asks:Level[]}
```

A public Trade is a committed fill from the internal matcher.
It is not a private resting order.
Multiple trades may share one timestamp.

Candle time aligns with its containing interval. Low ≤ open/close ≤ high.
A zero-volume candle must have equal OHLC values under the chosen carry-forward policy.
When several candles share a key, validate revisions before deduplicating.
An equal-revision value conflict is invalid, not a last-arrival-wins case.

A book range has `from <= to` and1–4096 changed levels across both sides.
A price occurs at most once on each side in a range.
Quantities are final absolute values; zero removes a level.
A complete snapshot has10–50 positive levels on each side, sorted and non-crossing.
A snapshot price is unique within its side.
Crossing checks occur after applying the complete range to a candidate book, before publishing that book.

## 4. Complete HTTP response shapes

### Metadata

Every field shown is required. Nested objects reject unknown fields.
Values below are the selected version1 defaults, not measured optimums.
The server emits the effective validated configuration using this exact structure.

```json
{
  "session": "s1",
  "symbol": "BTC-USD",
  "tickSize": "0.01",
  "lotSize": "0.0001",
  "intervals": ["1s", "1m", "5m"],
  "referencePrice": "64000.00",
  "tierPolicy": {
    "initialTier": "degraded",
    "flushMs": {"full": 100, "degraded": 500, "minimal": 2000},
    "enterDegraded": {"latencyAboveMs": 400, "jitterAboveMs": 60},
    "enterMinimal": {"latencyAboveMs": 900, "jitterAboveMs": 150},
    "recoverFull": {"latencyBelowMs": 300, "jitterBelowMs": 40},
    "recoverDegraded": {"latencyBelowMs": 700, "jitterBelowMs": 100},
    "downgradeDwellMs": 3000,
    "upgradeDwellMs": 10000,
    "missingReportStepMs": 5000,
    "missingReportMinimalMs": 12000,
    "pingEveryMs": 1000,
    "pongTimeoutMs": 3000,
    "reportEveryMs": 2000,
    "rttWindowSamples": 10,
    "minimumReportSamples": 2,
    "hiddenCloseMs": 180000
  },
  "retention": {
    "historyCandles": {"1s": 3600, "1m": 1440, "5m": 2016},
    "deliveryClosedCandles": 64,
    "recentTrades": 200,
    "bookChanges": 4096,
    "maximumBookLevelsPerSide": 50
  }
}
```

`session`, `symbol`, `referencePrice`, and decimals obey the scalar definitions.
Intervals contain the three supported values once, in displayed order.
All duration fields are positive integers at most3600000ms.
`flushMs` increases strictly from full to minimal.
Recovery thresholds are strictly below the corresponding entry thresholds.
Minimal entry thresholds exceed degraded entry thresholds.
Missing-report minimal time exceeds missing-report step time.
Sample bounds obey `2 <= minimumReportSamples <= rttWindowSamples <= 10`.
History counts are positive integers at most10000; bookChanges is1–4096; maximumBookLevelsPerSide is10–50.
deliveryClosedCandles is1–64 and recentTrades is1–200; other retention fields are also mandatory.
The selected values remain those above unless a reviewed policy change updates the fixtures and documentation.

### Other successful responses

```text
BookSnapshot = {session:SessionId, symbol:Symbol, seq:SafeUint, t:SafeUint,
                bids:Level[10..50], asks:Level[10..50]}
History = {session:SessionId, symbol:Symbol, interval:Interval,
           requestId:SafeUint, candles:Candle[0..requestedLimit]}
RecentTrades = {session:SessionId, symbol:Symbol, trades:Trade[0..requestedLimit]}
Health = {status:"ok"}
Readiness = {status:"ok"} | {status:"not_ready"}
```

History uses ascending time and one key per candle.
RecentTrades uses descending trade ID and no duplicate ID.
Successful readiness uses200; not_ready uses503.
History may be empty. Full book snapshots may not silently have missing required depth.
Meta and recent-trade requests also require current socket/session checks on arrival.

## 5. Error envelopes and mapping

HTTP errors use `{error:{code:ErrorCode,message:DisplayText}}`.
WebSocket errors use `{type:"error",session:SessionId,code:ErrorCode,message:DisplayText}`.

| Code | HTTP status when applicable | Meaning |
|---|---:|---|
| bad_request |400 | Invalid query or malformed HTTP request |
| not_found |404 | Unknown path |
| method_not_allowed |405 | Unsupported method; include Allow header |
| not_ready |503 | Initialization or readiness has not completed |
| busy |503 | Market capture queue/deadline could not serve the request |
| origin_denied |403 | Browser origin is not configured |
| rate_limited |429 | Request/admission rate limit; WS command rejection uses the same code |
| internal_error |500 | Unexpected server failure; no raw exception text |
| bad_message |WS only | Malformed JSON or schema |
| unknown_interval |WS only | Unsupported subscription interval |
| bad_request_id |WS only | Subscription ID is invalid or not newer |
| wrong_session |WS only | Client message refers to another server session |
| debug_disabled |WS only | Debug command disabled by configuration |
| capacity_reached |503 | Global socket capacity reached before upgrade |

The transport adapter maps domain/application failures into this catalogue once.
Public messages contain safe action text. Logs can include an internal error classification without exposing secrets.
Connection close reasons are fixed ASCII strings under123 bytes; never send raw error strings as close reasons.

## 6. WebSocket object schemas

Unless stated otherwise, every object requires `type` and `session` plus the listed fields, with no unknown fields.

| Direction/type | Fields and bounds |
|---|---|
| Server hello | v:integer1, symbol:Symbol, connId:ConnectionId, tier:Tier, autoTier:Tier, forced:Tier or null, hidden:boolean, flushMs:positive duration |
| Client subscribe | interval:Interval, requestId:PositiveId |
| Client ping / server pong | id:PositiveId |
| Client report | latencyMs/jitterMs:finite numbers0–60000, samples:integer2–10 |
| Client visibility | hidden:boolean |
| Client debug forceTier | action:"forceTier", value:Tier or "auto" |
| Client debug pongDelay | action:"pongDelay", value:integer0–4000 |
| Client debug dropNextBookDelta / disconnect | action is that literal; no value field |
| Server subscribed | interval:Interval, requestId:PositiveId |
| Server tier | tier:Tier, autoTier:Tier, forced:Tier or null, hidden:boolean, flushMs:positive duration, reason:DisplayText |
| Server heartbeat | marketRev:SafeUint, bookSeq:SafeUint, candleRequestId:PositiveId or null, candleLatestRev:PositiveId or null, feedReady:boolean |
| Server book_reset | reason:"cursor_expired" |
| Server candles_reset | interval:Interval, requestId:PositiveId, reason:"cursor_expired" |
| Server update | marketRev:PositiveId; optional book:BookRange; optional candles:CandleBatch; optional trades:Trade[1..50]; optional skipped:SafeUint |

`CandleBatch = {requestId:PositiveId,interval:Interval,items:Candle[1..65]}`.
The batch's candle times ascend without duplicates; each candle rev is at most update.marketRev.
The update contains at least one book, candles, or trades payload.
`skipped` is required when trades is present and forbidden otherwise.
Update trades ascend by ID without duplicates.
The effective tier and flushMs must agree with metadata policy, including hidden precedence.

On initial hello, inspect the integer v before applying the complete supported-version schema.
An unsupported integer version leads to close4002 and reload-required, not a generic malformed-message retry loop.
A malformed or absent version is a protocol error; do not process its market data.

Before any subscription, heartbeat candleRequestId and candleLatestRev are null.
After subscription, candleRequestId is the accepted ID. candleLatestRev remains null only when no candle exists.
Null heads disable only the corresponding candle-lag comparison, not transport or producer-health checks.
The per-message symbol comes from the accepted hello for this connection; no repeated symbol field is required on update.

## 7. Schema fixtures and independent checks

Shared JSON fixtures check both validators against the same contract.
Cover every HTTP success/error envelope and every WebSocket direction/type.
Use raw .json text fixtures for duplicate keys, trailing documents, invalid escapes, and depth limits.
Go and TypeScript must agree on accept/reject outcomes and normalized domain values.

Important rejection fixtures include unknown nested tierPolicy fields, inconsistent thresholds, missing retention keys, excess precision, unsafe IDs, and malformed nullable heads.
Examples shortened for explanation in protocol.md are not automatically complete acceptance fixtures.
Keep shape checks separate from stateful sequence, revision, and lifecycle tests.
