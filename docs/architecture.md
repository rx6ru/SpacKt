# SpacKt architecture and engineering decisions

This document describes the software architecture and its design decisions.
Read the [protocol](protocol.md) and [wire schemas](schemas.md) for external contracts.
The protocol document owns exact wire fields and behavioural numbers.

## 1. Selected system shape

One backend process owns one generated market.
A static Next.js frontend connects directly to its REST and WebSocket interfaces.
No authentication, database, or message broker is required for the selected read-only synthetic scope.

```text
                         BACKEND
logical clock + seeded generator
              │
              ▼
       single market owner
       book / trades / candles / history
              │
         copied publication ────────────────┐
              │                             │
              ▼                             ▼
   per-connection owner                REST capture
   tier / cursors / control             bounded copy
              │                             │
          WS messages                      HTTP
              └──────────────┬───────────────┘
                             ▼
                 BROWSER NETWORK BOUNDARY
                 parse / validate / epochs
                             ▼
          BookSync / CandleFeed / telemetry / connection state
                             ▼
                store snapshot + chart adapter
                             ▼
                 React screen and controls
```

An owner is the only execution path allowed to mutate a piece of state.
Analogy: one editor changes a master document; readers receive consistent copies.
This keeps the market independent from a slow reader without relying on a shared mutable object.

## 2. Decisions and rejected alternatives

| Decision | Selected option and reason | Strong alternative and why not selected | Reconsider when |
|---|---|---|---|
| Backend language | Go: explicit connection ownership, cancellation, race checking, and a small deployable binary | Node/TypeScript is viable and shares models; shared application logic is small here | Shared runtime logic becomes substantial or Go adds measured delivery cost |
| HTTP routing | Standard `net/http`; few routes and standard lifecycle | chi or a larger framework adds an API without a current missing feature | Route/middleware complexity grows materially |
| WebSocket library | `coder/websocket`; context-based calls and explicit limits | Gorilla is valid but uses different concurrency conventions; neither library proves application state safe | Actual API or maintenance evidence changes |
| Simulator | Bounded seeded order-flow events, fixed logical steps, no stochastic-process dependency | OU/Poisson can add realism, but introduce tuning and explanations unrelated to the central grading risks | A concrete demonstration requires those distribution properties |
| Market storage | Owned memory with bounded history | A database supplies durability that this invented market does not need | Real records must survive restart or support audits |
| Delivery | Immutable current delivery view plus per-client cursors; batch all market streams | Chart-only pacing is simpler but leaves most book traffic unchanged | Measurements show batching complexity outweighs saved traffic |
| Precision | Integer cents/ticks and quantity lots; decimal strings on wire | Decimal library supports more arbitrary scales at dependency and operation cost | Symbol precision cannot be represented with fixed configured scales |
| Candle freshness | Explicit revision per candle key | Larger-volume rule works in a restricted model but cannot order every metadata/empty-bar change | No change expected; revision keeps correctness explicit |
| Frontend router | App Router, one static layout and one client market screen | Pages Router is permitted; switching brings no clear benefit for one new screen | Framework constraints materially change |
| Production bundler | Next.js webpack static export. Verified with Tailwind and local fonts. | Turbopack failed to create a helper port in the tested build environment. | Turbopack passes the same build and browser checks |
| Frontend deployment | Static export; frontend on Render static site initially | Vercel is valid; a second provider adds configuration and account terms | Render pooled traffic becomes an observed constraint |
| State | Plain TypeScript engines plus Zustand vanilla selectors | A custom external store removes one dependency but requires its own subscription correctness work | Store needs remain trivial enough to justify that maintenance |
| Chart | Lightweight Charts with our data adapter | ECharts supports more general plots at broader API/bundle cost; self-fetching embeds violate the brief | Required interactions cannot be served by the selected renderer |
| Controls | Tailwind with selectively owned shadcn components backed by Radix | A full themed component suite imposes a larger visual system | Requirements call for a broader established product system |
| Runtime validation | `zod/mini` schemas at transport boundaries | Handwritten guards are possible; duplicate shape checks are easier to miss | Bundle measurement or schema complexity changes the trade-off |
| Testing | Go testing, Vitest, Playwright | A single framework cannot exercise both language runtimes and a real browser adequately | Runtime choices change |
| Icons | Radix Icons, one family | A second icon family adds inconsistent visual weight | A required accessible symbol is absent |
| Reordering | Buttons first; small pointer-based reorder after keyboard model passes | dnd-kit can help complex drag/drop, but this list is small | Accessible pointer implementation becomes larger or less reliable than maintained library use |

These are explainable choices, not claims that alternatives cannot work.
Do not use download counts or familiarity as the main technical reason.
At scaffold time, check current compatible releases and lock exact resolved versions.
Do not copy old version tables blindly.

## 2a. Clean Architecture: dependency direction, not copied folder names

Keep calculation rules independent from HTTP, WebSocket libraries, React, and storage technology.
Outer adapters translate inputs and outputs; they do not own candle or book rules.

The supplied Go template illustrates constructor injection and replaceable use-case dependencies.
Its domain Task also contains MongoDB identifiers and persistence/transport tags.
We adopt the separation intent and use stricter domain independence for this streaming product.
Its authentication, database, and CRUD endpoints solve different requirements.
Source: [template domain model](https://github.com/amitshekhariitbhu/go-backend-clean-architecture/blob/main/domain/task.go) and [use-case constructor](https://github.com/amitshekhariitbhu/go-backend-clean-architecture/blob/main/usecase/task_usecase.go).

The article's indexed sections emphasize handlers, business operations, and external adapters.
Only indexed portions were readable; the full Medium page was unavailable to the reader.
Its [author's repository](https://github.com/Rayato159/go-clean-arch-v2) documents a related Echo/PostgreSQL example with separate models and database entities.
Source: [Ruangyot Nanchiang's article](https://medium.com/@rayato159/how-to-implement-clean-architecture-in-golang-en-f50d66378ebf).
Neither reference requires us to introduce a repository when no persistent store exists.

### Backend import graph

An arrow means “may import.” It does not mean runtime message direction.

```text
cmd/server → transport, market, delivery, config
transport  → transport/wire, delivery, model, precision
market     → sim, book, candle, model
sim        → book, model
book       → model
candle     → model
tier       → model
delivery   → tier, model
precision  → model
transport/wire → model, precision
model      → standard-library value types only
```

Keep shared domain values and delivery-policy constants in `backend/internal/model`.
The fixed policy drives tier decisions, hidden-tab close, and metadata output.
Keep `internal/market` for runtime ownership and capture requests.
Putting both roles in market would permit the cycle `market → sim → market`.

Pure model values use integer ticks, lots, times, revisions, and validated domain enums.
They contain no JSON, BSON, form, database, or framework tags.
Only `internal/transport/wire` owns the transmitted decimal strings, JSON field names, and wire error bodies.
A DTO is a data-transfer object: a shape used at an external boundary.
A domain value represents the market concept independently of that boundary's encoding.

```text
JSON DTO → validate and translate → integer domain values → rules
JSON DTO ← encode and translate  ← domain result         ← rules
```

Do not reuse a decoded mutable map as published domain state.
The adapter must produce owned values with explicit validation results.
Tests cover both translation directions and prevent accidental float arithmetic.

### Application ports and composition

A port is a small behaviour contract needed by a consumer.
Define it in the consuming package, rather than a global interfaces package.

- `delivery.StateSource` returns the latest immutable `model.Publication`.
- `delivery.FrameSink` writes one typed delivery output with a deadline, returning success, duration, or a typed failure.
- `transport.MarketReader` captures metadata, book, trades, or candle history using a request context.

`delivery.FrameSink` receives an application output, not JSON text or a library connection.
Its transport adapter owns DTO conversion, encoding, the outbound byte limit, and the actual socket write.
Cursor commit occurs only after FrameSink reports success.
The adapter reports oversize as a typed failure before any market bytes are written.

`cmd/server/main.go` constructs concrete owners and adapters and passes them to their consumers.
This construction point is the composition root.
No module looks up dependencies in a global service locator.

A port does not require one interface for every function.
Use direct functions for pure calculations and interfaces only for real substitution boundaries.
The market owner implements StateSource and MarketReader structurally; it need not import the consumers.
Protocol ping control remains in the transport adapter and shares connection cancellation.
Application read events reach delivery as typed inputs after validation.

### Frontend import graph

```text
React entry → runtime/create-market-runtime
runtime     → net, engines, store, domain
net         → net/wire, domain
net/wire    → domain, zod/mini
engines     → domain
store       → domain, zustand/vanilla
chart       → domain, lightweight-charts
ui          → domain, store, chart, selected primitives
```

`src/domain/model.ts` contains plain TypeScript values and events, without framework or schema-library imports.
`src/net/wire/schema.ts` and `mapping.ts` validate and translate wire data.
Engines receive typed domain events and return state/effects.
They do not import Zod, React, Zustand, chart code, DOM objects, fetch, or WebSocket.
A supplied numeric `now` or small callback provides time where needed.

`src/runtime/create-market-runtime.ts` connects engines and adapters and dispatches session resets coherently.
The runtime owns browser listener registration through the lifecycle adapter and disposes its child resources.
React owns chart mounting and chart cleanup; it reads store snapshots and dispatches typed user actions.
The chart adapter never initiates fetches or subscriptions.

### Boundary checks

Automated import checks enforce these dependency boundaries.
Backend checks inspect `go list -json` imports; TypeScript checks inspect resolved project imports.
Tests include direct imports and transitive paths through local re-export files.
Dependency inversion is demonstrated by substitute StateSource/FrameSink tests, not by a directory name.

## 2b. Error ownership

Pure domain operations return typed domain errors without HTTP status or user-facing transport text.
The adapter maps those errors once into the protocol's documented error code and status.
Unknown internal failures become a generic `internal_error`; detailed diagnostics remain server-side.
Cancellation releases pending work and does not attempt a response after the requester has departed.
Application code does not expose raw database, library, or stack-trace errors to the browser.

## 3. Market owner and publication

The market owner contains the random generator, book, candle aggregator, retained trades, and history.
Only it mutates those values.
Use an injected logical clock and random source in pure domain code.
The live pacer schedules logical work from elapsed monotonic time.
Changing delivery or connected-client count never changes the random draw sequence.

During initialization, advance six hours of simulated history without sleeping.
Retain final random state, book, reference state, active candles, and retained history.
Capture the latest initialized trade price as the fixed session-change reference before readiness.
Discard historical trades beyond the recent retention budget.
Serve liveness early but fail readiness until initialization completes.
Measure initialization time before deployment; do not promise a sub-second boot.

Every complete event and scheduled clock step produces a publication revision.
The immutable delivery view contains:

- Full book, at most50 levels per side, and current book sequence.
- Up to4096 copied book-change records.
- Active plus64 closed candles for each interval.
- Last200 trades and last generated trade ID.
- Latest price, session-reference price, and producer revision.

Nested arrays and maps are immutable after publication.
An atomic pointer swap alone does not enforce that rule.
Use owned copies; verify aliasing and slow-reader cases.
Avoid publishing intermediate book changes before replenishment restores required depth.

Full REST candle history is not copied into every delivery publication.
REST submits a bounded capture request to the market owner.
The owner copies the requested slice and replies through a one-slot response channel.
DTO conversion, JSON encoding, and network writes happen after that copy, in transport adapters outside the owner.

Capture request queue capacity is32.
Request deadline is2s. On queue saturation or deadline, return503 `busy`.
A cancelled request cannot block the owner: response send uses its one-slot buffer and never waits for a departed receiver.
Process at most eight pending captures between simulation steps, then advance market work.
This prevents a request flood from indefinitely starving generation.

## 4. Simulator contract

Baseline symbol BTC-USD, reference price64000.00 USD, tick0.01 USD, lot0.0001 BTC.
Use a100ms logical step.
At each step, choose one seeded event:80% market trade,10% limit addition,10% cancellation.
This is an average event mix, not a fixed promise of eight trades in every real second.

A market event chooses buy or sell, consumes the current best opposite level, and records the actual fill.
Fill quantity is a seeded integer from1 to the smaller of10000 lots and that level's available quantity.
A trade cannot exceed available quantity.
Limit additions choose a valid side and non-crossing price near the current book.
They move bids toward the current best ask and asks toward the current best bid.
Cancellations remove a seeded amount from an existing level.
After each event, replenish the far end to20 levels per side and remove excess levels beyond50.
Every actual level change, including replenishment or removal, enters the sequence log.
If the emitted changes expose a spread above20 ticks, add recovery quotes around the previous midpoint.
Place the recovery bid10 ticks below that midpoint and the recovery ask10 ticks above it.
Then run depth repair again, so each published book keeps20 to50 levels per side.
The20-tick cap matches one initial20-level, one-tick ladder.
It is a demo rule, not exchange calibration.
A plain inward limit-addition flip can still leave large gaps after best quotes disappear.
Do not fake chart values to hide gaps.
Candles must use generated trade prices from the simulator.

Price bounds:100.00–100000.00 USD.
Per-level size bound:10.0000 BTC.
Per-generated-trade size bound:1.0000 BTC.
When a boundary prevents a proposed change, choose a deterministic valid alternative; do not redraw based on wall-clock timing.
Test boundary behaviour directly rather than relying on chance to reach it.

The initial midpoint is a reference for placing a plausible book, not a guarantee about the latest trade.
Do not compare mid-price and last trade within one tick as a continuity invariant.
Startup continuity instead means the live simulation continues the same final state and event ordering.

Keep generator configuration fixed within a session.
Tests use a fixed epoch. Live boot anchors historical timestamps to the boot-time UTC reference.
The same seed reproduces relative event order; exact absolute timestamps also require the same epoch and configuration.

## 5. Connection ownership

Each socket has:

1. One reader that reads and validates client messages.
2. One connection owner that mutates tier state, cursors, subscriptions, and debug state and serializes application writes.
3. A liveness task using the library protocol-ping API, with coordinated cancellation.

Reader events use a bounded32-entry channel.
Queue overflow closes that connection, not the market.
Connection cancellation stops reader, owner, liveness, delayed-pong work, and registry membership.

The owner checks ready control messages before preparing a new market batch.
Controls cannot bypass bytes already blocked on TCP.
A write has a deadline, and application RTT includes queue and scheduling delay.
Do not claim the pong path measures only physical network travel.

Delayed debug pongs use due-time entries, not sleeping goroutines per ping.
A registry exposes immutable per-connection diagnostic snapshots rather than pointers to mutable connection state.
Registry locks cover add/remove/copy only, never network operations.

## 6. Browser responsibilities

| Module | Owns | Must not own |
|---|---|---|
| Connection | Socket epoch, reconnect, hello/session, control sending | Book mutation or chart drawing |
| Codec | JSON/schema validation and exact decimal conversion | Network retries or UI state |
| BookSync | Snapshot generation, buffer, book range application, panel sync state | WebSocket creation |
| CandleFeed | Selection requestId, history generation, revision merge, sorted bounded candles | Renderer lifecycle |
| RecentTrades | Session-aware REST/live ID merge, bounded recent list, latest-trade selection | Socket creation or UI formatting |
| Telemetry | Ping IDs, local timing, terminal results, reports | Automatic tier classification |
| Store publisher | Immutable UI snapshots and dirty frame scheduling | Core aggregation |
| Chart adapter | Series data conversion, ascending updates, inspection, chart cleanup | Fetching or subscribing |
| React UI | Labels, controls, layout, focus, user feedback | Wire decoding and sequence arithmetic |

Candle history REST requests include the current subscription requestId.
Socket candle payloads echo that requestId.
Keep book/trade processing active when only the candle interval changes.
At server-session change, reset every relevant engine before accepting new market values.

Track transport health, producer progress, and individual panel continuity separately.
An empty history is a valid loaded result, not a transport failure.
The chart can become live when a current-generation live candle arrives after empty history.
Fetch metadata and recent trades alongside book and history after hello.
Merge REST and live trades by ID within the session; a late REST response cannot replace a newer last trade.

Process validated events through bounded ordered engines, then publish UI changes using requestAnimationFrame.
This batches bursts and avoids coupling React renders to every raw message.
It does not guarantee performance by itself; profile the actual screen.

## 7. Practical SOLID

SOLID names five design principles. Apply their useful boundaries without manufacturing abstraction layers.

| Principle | Meaning | Application here | Avoid |
|---|---|---|---|
| Single responsibility | One reason for a module to change | BookSync changes for sequence rules; chart adapter changes for rendering APIs | A component that fetches, aggregates, sorts, reconnects, and renders |
| Open/closed | Add behaviour through clear extension points | Interval configuration and generator inputs extend existing algorithms | A plugin framework for three fixed intervals |
| Liskov substitution | Replacements preserve the promised behaviour | Fake clock and real clock obey the same time contract | A fake transport that omits close/error semantics the real one has |
| Interface segregation | Consumers need only relevant operations | CandleFeed receives history fetching and update input, not the entire server object | Giant service interfaces |
| Dependency inversion | Policy depends on small boundary contracts | Tier machine receives input and time; it does not call global clock or socket APIs | Repository/service/controller layers with no real isolation benefit |

Use functions and structs when they are the simplest expression.
An interface is justified by an actual replaceable boundary, not by a naming convention.
No unnecessary inheritance hierarchy is planned.

## 8. Public boundaries for independent tests

These signatures state meaning, not implementation.
Boundary DTOs preserve protocol.md and schemas.md. Domain types preserve their meaning using integer values.

```text
ParsePrice(text) -> integer ticks or validation error
ParseQuantity(text) -> integer lots or validation error
Simulator.Next(logicalTime) -> ordered book changes and zero/one trade
Book.Snapshot() -> immutable levels and sequence
Candles.Apply(trade) / Candles.Advance(logicalTime) -> changed candle keys
Candles.History(interval,limit) -> copied ascending candle values
Tier.Step(state,input,monotonicNow) -> next state and reasoned transitions
Delivery.Build(publication,cursors,subscription) -> typed output and candidate next cursors
BookSync.receiveRange(range) / receiveSnapshot(snapshot,generation) -> state and effects
CandleFeed.select(interval,requestId) / receiveHistory / receiveLive -> state and effects
Telemetry.pingSent(id,time) / pongReceived(id,time) / advance(time) -> reports and timeouts
```

Effects describe requested work, such as fetch snapshot or schedule retry.
Tests can assert effects without mocking private helper calls.
When a public contract changes, independent test review precedes implementation changes.

## 9. Deployment and security boundaries

Backend: Render Docker web service.
Frontend: separate Render static site for the first delivery.
This uses one platform while meeting the separate-service bonus.
Check current monthly allowances and measured byte rates before sharing the deployed URL widely.
Vercel static hosting remains a documented alternative if budget measurements favour it.

Docker Compose runs the same backend and a static frontend server locally.
Browser URLs use published localhost ports, never Compose-only service names.
Use a backend `-healthcheck` executable mode for Compose readiness in the small non-root runtime image.
Render checks `/readyz` for readiness.

Runtime configuration comes from these environment variables.
`-addr` overrides `PORT` for local tests and manual runs.

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Selects the HTTP listen port and the default healthcheck target. |
| `SPACKT_SEED` | `7` | Selects the deterministic simulator event stream. |
| `SPACKT_EPOCH_MS` | `0` | Uses current-time alignment when zero. Uses a fixed epoch when positive. |
| `SPACKT_HISTORY_MINUTES` | `360` | Selects the generated warm history window. |
| `SPACKT_ALLOWED_ORIGINS` | local frontend origins | Selects exact HTTP or HTTPS browser origins. |
| `SPACKT_DEBUG_CONTROLS` | `true` | Enables or disables debug WebSocket controls. |
| `SPACKT_MAX_CONNECTIONS` | `100` | Caps active WebSocket connections. |
| `SPACKT_MARKET_FRAME_BUDGET_BYTES` | `1048576` | Caps one outgoing market frame. |
| `SPACKT_BOOK_CHANGES` | `4096` | Caps retained order-book changes. |

CORS allows configured frontend origins for REST.
WebSocket upgrade origin is checked separately.
Public frontend environment variables contain public URLs only.
Build-time values are frozen into the static output; document that URL changes require rebuilding.

A release build derives allowed inline-script hashes from the actual static output before emitting CSP configuration.
Avoid nonce-only CSP for an otherwise static page.
Test the built page under the actual policy, including chart rendering and style updates.
CSP connect-src lists both backend HTTPS and WSS origins.

Do not trust arbitrary X-Forwarded-For values.
Local mode uses the direct peer address.
Hosted proxy mode is explicitly configured from the provider's documented trusted boundary; verify it before enabling IP limits in production.
Global connection and per-connection message limits remain effective independently of client-IP attribution.

## 10. What would change this architecture?

Measured publication-copy cost could justify a narrower immutable log representation.
A persistence requirement could justify a database and durable order/event log.
Several market owners could justify symbol partitioning and a stream between owners and gateways.
Many identical client payloads could justify aligned shared encoding with separate catch-up handling.
Actual broker selection waits for that distribution requirement.

Do not quote fixed viewer capacity, startup time, or encoding throughput without a recorded benchmark.
The first scaling calculation is measured bytes per update × updates per second × connected clients.

## 11. Sources for API and platform decisions

- [Go HTTP](https://pkg.go.dev/net/http), [Go context](https://pkg.go.dev/context), [race detector](https://go.dev/doc/articles/race_detector).
- [coder/websocket](https://pkg.go.dev/github.com/coder/websocket): concurrent method rules, Ping, read limits, context behaviour.
- [Next static export](https://nextjs.org/docs/app/guides/static-exports): build capabilities and server-feature restrictions.
- [React external stores](https://react.dev/reference/react/useSyncExternalStore): stable snapshot contract.
- [Lightweight Charts series API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesApi): normal and historical updates.
- [shadcn](https://ui.shadcn.com/docs), [Radix primitives](https://www.radix-ui.com/primitives/docs/overview/introduction): component ownership and interaction foundations.
- [Render Blueprints](https://render.com/docs/blueprint-spec), [free-service constraints](https://render.com/docs/free).
- [Docker Compose readiness](https://docs.docker.com/compose/how-tos/startup-order/), [Next CSP](https://nextjs.org/docs/app/guides/content-security-policy).

Implementation must verify the exact chosen versions against these current upstream contracts.
