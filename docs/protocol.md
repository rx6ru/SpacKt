# SpacKt protocol and behaviour contract

Version 1 protocol contract.
This document is authoritative for behaviour, units, boundaries, and shared algorithms.
[Wire schemas](schemas.md) defines exact field types, nesting, strictness, and complete HTTP metadata.

## 1. Representation and identity

Transport is JSON over HTTP and WebSocket.
Market prices and quantities are decimal strings.
Price scale is two decimal places; quantity scale is four.
Parse directly into integer ticks and lots; never parse through binary floating-point first.
All ordering IDs, revisions, and millisecond times must be safe integers in JavaScript.

- `session`: opaque identifier for one backend run.
- `seq`: increasing book-change number within that session.
- `id`: increasing trade number within that session.
- `marketRev`: increasing publication number from the market owner, including healthy clock progress.
- `rev`: publication number of the last change to one candle, including its closed state.
- `requestId`: browser-issued positive integer identifying one candle subscription generation.
- `t`: UTC milliseconds since the Unix epoch for market records.

A candle key is `(session, symbol, interval, t)`.
A higher candle `rev` replaces a lower revision of that key.
Equal revision with unequal values is invalid data and causes candle resynchronization.
Do not compare revisions or sequence numbers across sessions.

## 2. Shared value shapes

```text
Interval = "1s" | "1m" | "5m"
Tier = "full" | "degraded" | "minimal"
Level = [price: decimal string, quantity: decimal string]
Trade = {id, t, p, q, side: "buy" | "sell"}
Candle = {t, o, h, l, c, v, rev, closed: boolean}
BookRange = {from, to, bids: Level[], asks: Level[]}
```

`side` is the simulated initiating trader's direction.
A buy takes available asks. A sell takes available bids.
Zero quantity is permitted only for removal entries in book ranges, or candle volume.
Trades have strictly positive quantity.
Unknown enum values, negative sizes, unsafe IDs, and nonfinite numbers are rejected.
Use only decimal digits with an optional fractional part; reject exponent notation, signs, whitespace, and excess precision.
Zero book removal accepts `"0"` or `"0.0000"`.

## 3. HTTP endpoints

All `/api/` responses use `Cache-Control: no-store`.
Every successful market response contains `session` and `symbol`.
Errors use `{error:{code,message}}`; do not return stack traces.
The complete error catalogue and adapter mapping are in schemas.md.

| Endpoint | Request bounds | Successful response |
|---|---|---|
| `GET /api/meta` | No parameters | Session, symbol, tickSize, lotSize, intervals, fixed referencePrice, tierPolicy, retention |
| `GET /api/book` | No parameters | `{session,symbol,seq,t,bids,asks}` from one consistent captured state |
| `GET /api/candles` | interval required; limit 1–1000, default500; requestId optional0 or positive safe integer | `{session,symbol,interval,requestId,candles}` ascending by t, unique keys |
| `GET /api/trades` | limit1–100, default50 | `{session,symbol,trades}` newest first |
| `GET /healthz` | No parameters | 200 `{status:"ok"}` when process can answer; not a market freshness claim |
| `GET /readyz` | No parameters | 200 `{status:"ok"}` after initialization and recent owner progress; otherwise503 `{status:"not_ready"}` |

Unknown interval, invalid number, duplicate parameter, or unexpected query parameter returns400 `bad_request`.
Unknown route returns404. Unsupported method returns405.
During startup, `/api/` returns503 `not_ready`; health/readiness routes stay available.
`/readyz` requires market-owner publication within two server-monotonic seconds.
Shutdown makes readiness fail before closing sockets.

Before readiness, capture the latest initialized trade price as referencePrice.
It remains fixed for that session and changes only when a new session initializes.
Every browser fetches meta after hello and checks its session before using the reference.
A failed or mismatched meta response keeps price movement unready while recovery retries.
Fetch recent trades after hello, alongside meta, book, and history.
Merge trade REST and socket data by ID within the session, keeping the largest ID as latest price.
A late REST response cannot roll back a newer trade.
Skip already-seen IDs and retain at most100 recent trades in the browser.

Candle history includes the active candle if present.
Default initial browser request is 500 candles, limited by available retained data.
Six hours span 360–361 one-minute buckets and 72–73 five-minute buckets, depending on start alignment.
Retained duration, API limit, and initial visible range are different quantities.
No older-history pagination endpoint is included in version1.

Example snapshot, shortened for readability:

```json
{"session":"s1","symbol":"BTC-USD","seq":102,"t":1700000000100,
 "bids":[["99.00","2.0000"]],"asks":[["101.00","3.0000"]]}
```

The implemented response contains the full bounded book, not only these two example levels.

## 4. WebSocket lifecycle

Local endpoint: `ws://localhost:8080/ws`.
Deployed endpoint: the configured backend's public `wss://` address followed by `/ws`.
The server validates `Origin` against the configured frontend allow-list.

Server sends first:

```json
{"type":"hello","v":1,"session":"s1","symbol":"BTC-USD","connId":"c1",
 "tier":"degraded","autoTier":"degraded","forced":null,"hidden":false,"flushMs":500}
```

Browser checks version before subscribing.
A mismatch closes4002 and shows a reload action without automatic retries.
Every subsequent message in either direction includes the current `session`.
The server rejects mismatched session messages with `wrong_session`; the client reconnects and reloads state.
New sockets require a new hello and reset per-connection tier state.
Browser handlers also check their local socket epoch before accepting any message.

## 5. Browser-to-server catalogue

| type | Fields beyond type/session | Contract |
|---|---|---|
| `subscribe` | `interval,requestId` | Replaces candle subscription; requestId must exceed this connection's previous requestId |
| `ping` | `id` | App probe ID; browser keeps local send time; server echoes ID |
| `report` | `latencyMs,jitterMs,samples` | Finite0–60000ms values; samples integer2–10; invalid reports do not refresh report liveness |
| `visibility` | `hidden:boolean` | Controls effective delivery and measurement policy |
| `debug` | `action` plus action-specific value | Exactly one action per command; caller's connection only |

Debug actions:

```text
{action:"forceTier",value:"full"|"degraded"|"minimal"|"auto"}
{action:"dropNextBookDelta"}
{action:"disconnect"}
{action:"pongDelay",value: integer 0..4000 milliseconds}
```

`pongDelay` delays app-pong eligibility without sleeping in the connection owner.
Limit scheduled pongs to eight. Overflow closes4008.
Applying the same forced tier twice is harmless.
Repeated drop commands coalesce into one pending boolean; they do not accumulate unbounded omissions.
No `emptyHistory` server debug flag exists. Empty history is covered by controlled fixtures.

## 6. Server-to-browser catalogue

| type | Additional fields | Meaning |
|---|---|---|
| `subscribed` | `requestId,interval` | Subscription applied; seed candle update follows if available |
| `pong` | `id` | Echo for a known application probe |
| `update` | `marketRev,book?,candles?,trades?,skipped?` | At least one market payload is present |
| `tier` | `tier,autoTier,forced,hidden,flushMs,reason` | Effective policy and its source; sent when displayed policy changes |
| `heartbeat` | `marketRev,bookSeq,candleRequestId,candleLatestRev,feedReady` | Current producer progress and stream heads; every1s, independent of tier |
| `book_reset` | `reason:"cursor_expired"` | Re-enter book buffering and fetch a new snapshot |
| `candles_reset` | `requestId,interval,reason:"cursor_expired"` | Reload current generation's history |
| `error` | `code,message` | Actionable, bounded error response |

`update.candles = {requestId,interval,items:Candle[]}`.
`items` are ascending by opening time.
`update.trades` are ascending by ID; at most50 per market flush.
`skipped` states the number of newly unseen trade IDs omitted before the transmitted suffix.
The server computes this value from the current connection's trade cursor.
The browser counts each omitted ID once per backend session, including across reconnects.
It uses a separate WebSocket trade cursor. REST arrival order does not change this count.
Trade-list omissions do not change candle aggregation or book continuity.
The browser retains at most100 displayed trades and reports skipped display records in diagnostics.

```json
{"type":"update","session":"s1","marketRev":84,
 "book":{"from":101,"to":104,"bids":[["99.00","1.0000"]],"asks":[]},
 "candles":{"requestId":3,"interval":"1s","items":[
  {"t":1700000000000,"o":"100.00","h":"104.00","l":"99.00",
   "c":"99.00","v":"6.0000","rev":84,"closed":true}]},
 "trades":[{"id":8,"t":1700000000800,"p":"99.00","q":"3.0000","side":"sell"}],"skipped":0}
```

A `subscribed` response and candle seed can occur immediately outside the steady-state tier cadence.
Observed rate counts all candle-bearing update messages, including these seeds.
Use a rolling ten-second browser-monotonic window.
Before ten seconds elapse, divide by actual elapsed observation time and label the shorter window.
Display a dash until at least one second has elapsed; pongs and heartbeats never count as chart messages.
The UI labels the target as a steady-state ceiling rather than a universal message limit.

## 7. Book correctness algorithm

Each book mutation increments `seq` once for one level's replacement/removal.
Publish the result only after one complete simulated event and its depth repair.
Each outbound range lists every touched level in `(sentSeq,currentSeq]`, with its final absolute size.
A net difference between endpoint states is insufficient when values reverse inside the range.

Browser initial or reset procedure:

1. Enter BUFFERING before requesting the snapshot.
2. Assign a new snapshot generation and abort the previous request.
3. Capture at most500 ranges or two MiB while the request is pending.
4. Accept the snapshot only for the current generation, socket epoch, and server session.
5. Set `expected = snapshot.seq + 1` and replay buffered ranges in receipt order.
6. For `to < expected`, ignore already-covered information.
7. For `from > expected`, restart synchronization.
8. Otherwise apply every absolute level replacement, then set `expected = to + 1`.
9. Check book invariants after the whole range, not after each individual level mutation.
10. Mark the book synchronized only after replay succeeds.

A reversed or invalid range is malformed and triggers recovery.
A new snapshot generation rejects any late result from a previous retry.
A book recovery episode allows five total attempts. The first is immediate.
Delays before attempts2–5 are0.5s,1s,2s,4s respectively.
Each HTTP attempt has a5s browser deadline and two-MiB response-body cap.
Use the same bounded policy for metadata, history, and recent-trade bootstrap, each with its own one-request owner.
After exhaustion, show a retry action; a successful sync resets the attempt counter.
A buffer overflow cancels the current attempt and spends the next attempt from the same episode budget.
Repeated gaps, reset messages, and overflows do not reset the budget.
Only a completed valid synchronization or an explicit Retry begins a fresh recovery episode.
An interval change cancels its previous history episode and starts a new generation; it does not reset an unrelated book episode.

The server keeps4096 book-change records.
An expired cursor causes `book_reset`, advances server sentSeq to the current published seq, and resumes later ranges.
The client buffers those later ranges while obtaining its replacement snapshot.
The server commits normal sent cursors only after a successful write.
A failed write closes the connection; it does not retry uncertain application coverage on that socket.

## 8. Candle calculation, merging, and retention

Intervals use half-open UTC buckets: `[start,start+duration)`.
Bucket start is `floor(tradeTime/duration)*duration`.
Every trade contributes once to each interval.
On a bucket's first real trade, O/H/L/C equal that trade's price and volume equals its quantity.
Subsequent trades update high, low, close, and volume.

Empty periods after an initial real trade carry the previous close with zero volume.
An active zero-trade placeholder resets all OHLC values when its first real trade arrives.
No candle exists before the first real trade in the simulated run.
Clock advancement closes candles even without trades and creates the next empty placeholder.
A new key is always deliverable, even if it repeats the prior candle's OHLCV.

Connection delivery retains the previously sent active candle and compares revisions from that key onward.
Send its final changed value plus every newly changed/created candle up to the active candle.
Keep64 closed candles plus the active candle per interval in the published delivery view.
If a connection needs older candles, send `candles_reset` instead of guessing.

Authoritative history retention: 3600 one-second,1440 one-minute,2016 five-minute candles, including active if present.
REST captures a consistent copy of the requested history from the market owner.
Browser history/live merge chooses the higher `rev` for each candle key.
Both paths check session, selected interval, requestId, and local request/socket generations.
An older subscription's A message cannot update a later A selection after A→B→A.

## 9. Measurement and tier machine

App ping every1s while visible; expiry3s; maximum four unresolved probes.
Each ID completes once. Ignore late, duplicate, unknown, and old-epoch pongs.
Use one browser monotonic clock for send and receive.
Store successful RTTs in ping-send order, bounded to the latest ten successes.
Sampling age uses the browser send timestamp, with the same monotonic clock.
Latency is their median. Jitter is mean absolute difference between consecutive successful RTTs.
At least two successes no older than10s are required before a valid report.
Expire older successes even when no new pong arrives; do not repeatedly report an old healthy window.
The server uses receive time for report deadlines; one report cannot supply future dwell evidence.
Report every2s. Do not report unknown jitter as zero.
Successes separated by timeouts can be adjacent in this statistic; document that limitation.
Ping timeout count is diagnostic only, not a packet-loss estimate or automatic-tier input in version1.

| Current transition | Latency | Jitter | Combination |
|---|---:|---:|---|
| Enter degraded from full | >400ms | >60ms | Either bad signal |
| Enter minimal | >900ms | >150ms | Either bad signal |
| Recover minimal→degraded | <700ms | <100ms | Both good signals |
| Recover degraded→full | <300ms | <40ms | Both good signals |

Strict comparisons mean equality stays in the current band.
New automatic tier: degraded.
Downward evidence must be confirmed by a later valid report after at least3s.
Keep separate bad-since timers for degraded-or-worse and minimal conditions.
Choose the worst boundary whose continuous bad evidence is confirmed.
An intervening nonqualifying report resets that boundary's timer.
Invalid reports also clear dwell evidence, without refreshing the last valid report time.
Upward evidence needs10s, moves one tier, then restarts its timer.
All evidence timers reset on reconnect and hidden/visible transition.

After5s since the last valid visible report, downgrade one tier once.
After12s, set automatic tier minimal.
A missing-report fallback clears dwell evidence even when the automatic tier is already minimal.
A fresh report rearms the next missing-report episode but starts fresh evidence timers after a silence fallback.
A new connection's report deadline starts at hello.
Hidden time pauses missing-report penalties; visible return restarts the deadline at zero.

If a successful market write takes more than1s, downgrade auto one tier and clear upgrade evidence.
Each write deadline is5s; a failed write closes the socket.
Visible forced tier overrides auto; hidden overrides both:
`effective = hidden ? minimal : (forced ?? auto)`.
The automatic tier continues processing valid reports while forcing is active.
Changes never alter market generation or aggregation.

Steady-state market flush intervals: full100ms, degraded500ms, minimal2000ms.
All market streams share this cadence; control/health messages do not.
This all-stream choice extends the required chart adaptation to reduce actual traffic.
A tier change resets its next flush timer; do not replay missed timer ticks as a burst.

## 10. Health, freshness, and lifecycle

Server sends protocol ping every15s with a10s timeout.
One failed ping closes the connection; library context expiry may already close it.
The WebSocket reader remains active so protocol pongs can be processed.
Protocol ping and application RTT measurement are separate mechanisms.

A heartbeat reads current market publication; it must not fabricate producer progress.
`marketRev` advances from owner clock progress at least every100ms while healthy, even without a trade.
Visible browser transport silence for10s triggers stale/reconnect.
No increasing `marketRev` for5s marks market panels feed-delayed, even if pongs arrive.
While hidden, suspend browser freshness alarms because browser scheduling is intentionally reduced.
On visible return, clear old freshness timers and require fresh evidence before normal LIVE state.
Track whether each panel head advances toward advertised heartbeat heads.
If it makes no progress for `max(5s,3*flushMs)` while a same-session advertised head remains ahead, resync that panel.
Reset the no-progress timer whenever the local applied head advances.
Simply remaining behind a constantly advancing live head is not sufficient to trigger resync.
Thus a healthy quiet feed remains live, but lost payload delivery cannot hide behind pongs or heartbeats.
Ignore candle-head comparisons for noncurrent requestId.

Hidden: send visibility, stop probes/reports, reduce effective tier, keep bounded engines processing.
Close after180s hidden with4001; do not reconnect while hidden.
Return visible: clear probe samples and evidence, restart probes immediately, and resync if freshness/continuity is uncertain.
Handle offline/online, pagehide, and persisted pageshow explicitly.
Unsubscribe listeners, stop timers, abort requests, and remove chart resources on disposal.

Reconnect full jitter: random delay from0 to `min(10s,500ms*2^attempt)`.
Reset attempts after30s of healthy synchronized live operation.
Close4001 reconnects when visible;4002 never retries;4008 starts with at least10s delay and caps at30s.
Close4009 marks cached data stale and permits one automatic fresh connection after a random10–30s delay.
That connection reloads meta, book, trades, and history through the normal recovery path.
If4009 repeats before30s of healthy synchronized operation, stop automatic retry and show a manual Retry action.
Other failures use ordinary backoff. An online event permits a new immediate attempt.

## 11. Limits and errors

| Limit | Baseline |
|---|---|
| Active sockets | 100; reject upgrade with503 when full |
| New sockets per source IP | Token bucket30/minute, burst10; HTTP429 before upgrade |
| Inbound WebSocket message | 4096bytes; close1009 when exceeded |
| Inbound control rate | Token bucket20 tokens/second, capacity20; each application message consumes1; close4008 on the first message without a token |
| Debug command rate | One/second; reject extra command with rate_limited without applying it |
| Per-connection control queue | 32 validated events; full queue closes4008 |
| Book sync buffer | 500 ranges or two MiB, whichever comes first |
| Server outbound market update | One MiB after UTF-8 encoding; reject before write, preserve sent cursors, and close4009 payload_too_large |
| Pending REST work | One request each for metadata, book, trades, and current history;5s request deadlines and bounded attempts |

Error codes and HTTP mappings: see schemas.md section5.
A FrameSink oversize error closes4009 before sending any part of the market update.
Do not truncate market data, split a sequence range without a new contract, or advance unsent cursors.
Transport tests inject a smaller market-frame budget to exercise this otherwise unlikely path.
Malformed JSON and recoverable invalid messages are rejected and counted; error messages are limited to one per10s per connection.
Protocol-version mismatch closes4002; debug disconnect4003; hidden timeout4001; shutdown1001; normal disposal1000.
A failed transport or failed liveness probe may surface as abnormal closure1006 at the browser;1006 is never transmitted.
Graceful shutdown: fail readiness, stop accepts, close connections1001, cancel owners, allow up to10s, then exit.

## 12. REST origin and browser access contract

Public market reads do not use cookies or other browser credentials. Use fetch credentials:"omit".
For a configured Origin, echo that exact value in Access-Control-Allow-Origin on success and error responses.
Include Vary: Origin. Never emit Access-Control-Allow-Credentials or wildcard origin for these routes.
Requests without Origin may use public read endpoints; CORS is not authentication.
A present but unconfigured Origin receives403 origin_denied without an allow-origin header.

For known /api routes, OPTIONS preflight permits GET and the Accept header only.
Validate Origin, Access-Control-Request-Method, and every requested header case-insensitively.
Return204 with exact allow-origin, Access-Control-Allow-Methods: GET, and Access-Control-Allow-Headers: Accept.
Include Vary for Origin, Access-Control-Request-Method, and Access-Control-Request-Headers.
Unsupported requested methods or headers return403. Ordinary unsupported request methods return405 with Allow: GET, OPTIONS.
Do not send Content-Type or custom request headers on GET from the application.
Keep WebSocket Origin validation separate; REST preflight does not authorize a socket upgrade.

## 13. Configuration validation

Environment overrides are parsed and checked before accepting market traffic.
They configure deployment and resource bounds, such as origins, history length, frame bytes, and connection caps.
The delivery tier policy is fixed in version1 and tested from one shared backend constant set.
The tier machine, hidden-close path, and /api/meta use that same constant set.
The frontend displays /api/meta values; it does not silently duplicate different threshold constants.
Initial ready snapshots and metadata must share the backend session.
