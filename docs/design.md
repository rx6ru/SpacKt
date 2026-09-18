# SpacKt UI and UX Plan

Status: selected UI planning baseline. Implementation has not started.

This document defines the trading screen. It does not define backend logic.

## 1. Product Read

Read this as a real-time market console for a reviewer and an interview panel.

The screen must prove that the market stream is correct. It must also feel polished.

The screen is not a landing page. It must open on the working product.

The screen must show the chart, order book, trades, connection status, tier, and debug controls.

## 2. Source Inputs

The assignment requires one responsive React and Next.js screen.

The screen must show these items:

| Required item | UI place |
|---|---|
| Latest price and movement | Top market strip |
| Candlestick chart | Center work area |
| At least two intervals | Chart toolbar |
| Candle inspection | Chart legend and inspect panel |
| Top 10 bids and asks | Right book panel |
| Recent trades | Lower panel |
| Current connection status | Top right status cluster |
| Active tier and configured target rate | Status cluster and diagnostics |
| Forced tier control | Diagnostics drawer or lower panel |
| Stale values while disconnected | Full surface state |

Visual references are treated as mood references, not literal assets.

| Reference | Useful signal |
|---|---|
| Image 1 | Ivory, cobalt, black, fine line movement |
| Image 2 | Cobalt on dark ground, organic signal field |
| Image 3 | Cobalt highlight with glossy contrast |
| Image 4 | Dense poster typography, black field, white rails |
| Image 5 | Halftone texture with strict black and white UI |
| Image 6 | Technical instrument panel, data as topography |
| Image 7 | Pixel bar, black module, useful budget-like meter |

Do not use these as page decoration. Convert them into tokens and layout rules.

## 3. Audience

| Audience | Need |
|---|---|
| Reviewer | See every assignment requirement quickly |
| Interviewer | Ask "why" and get a visible answer |
| Amar | Explain each state and debug each failure |
| Future maintainer | Find the UI behavior from acceptance IDs |

The UI must avoid mystery. Every important state must have a label.

## 4. Core Concept Model

| Term | What it is | Analogy | Why it matters here |
|---|---|---|---|
| Trade | One completed buy or sell | A receipt | Trades form price and volume |
| Candle | A summary of trades in one time slot | A weather report for one hour | The chart uses candles |
| OHLCV | Open, high, low, close, volume | First, max, min, last, total | Candle inspection must show these values |
| Order book | Buyers and sellers by price | A market stall board | The UI must show 10 bids and 10 asks |
| Bid | Buy interest | "I will buy at this price" | Bids sort high to low |
| Ask | Sell interest | "I will sell at this price" | Asks sort low to high |
| Spread | Best ask minus best bid | Shop buy price vs sell price | It proves the book is plausible |
| WebSocket | Long-lived browser connection | A live phone call | It carries live market updates |
| REST snapshot | One full HTTP answer | A fresh photocopy | It starts or repairs the local book |
| Delta | Ordered book change | A numbered page in a log | Missing pages trigger resync |
| RTT | Ping round-trip time | Echo time across a valley | It feeds tier selection |
| Jitter | RTT instability | Commute time variation | It detects unstable links |
| Tier | Delivery speed for one client | A water tap setting | It controls update frequency |
| Hysteresis | Slow switching rule | Thermostat gap | It prevents tier flapping |
| Stale | Data shown from cache | A frozen scoreboard | It protects user trust |

## 5. Design Goals

G1. Make the chart the dominant object.

G2. Keep 10 bid rows and 10 ask rows visible at desktop sizes.

G3. Show status, tier, RTT, jitter, timeout count, and observed rate without opening DevTools.

G4. Make forced tier changes visible and reversible.

G5. Make stale, syncing, resyncing, and reload states impossible to miss.

G6. Keep interaction smooth during frequent updates.

G7. Use dense controls without generic dashboard cards.

G8. Preserve accessibility through keyboard, contrast, and non-color labels.

## 6. Aesthetic Direction

Name: cobalt market instrument.

Decision: selected.

Tone: dense, restrained, technical, and editorial.

The screen uses black and charcoal as the main field.

Ivory text creates readable contrast.

Cobalt is the single brand accent.

Green, red, and amber are semantic signals only.

Halftone and pixel ideas may appear only inside small meters or loading skeletons.

Do not place decorative overlays on the chart.

## 7. Tokens

Use CSS variables. Do not hard-code colors inside components.

| Token | Hex | Use | Contrast sample |
|---|---:|---|---:|
| `--ink` | `#0B0D10` | App background | Ivory on ink: 17.11:1 |
| `--surface` | `#11151A` | Panels and controls | Muted on surface: 8.12:1 |
| `--surface-2` | `#171D24` | Raised panels | Muted on surface-2: 7.52:1 |
| `--line` | `#2C3440` | Dividers | N/A |
| `--text` | `#F4F0E7` | Primary text | Text on ink: 17.11:1 |
| `--muted` | `#A7ADB7` | Secondary text | Muted on surface: 8.12:1 |
| `--accent` | `#2454FF` | Cobalt controls | White on accent: 5.55:1 |
| `--accent-soft` | `#D7E0FF` | Accent text on dark | Accent-soft on surface: 13.96:1 |
| `--buy` | `#6FD6A7` | Buy side | Buy on ink: 10.98:1 |
| `--sell` | `#FF7A7A` | Sell side | Sell on ink: 7.71:1 |
| `--warn` | `#F5B84B` | Stale and warning | Warn on ink: 10.97:1 |

Contrast values were measured with the WCAG relative luminance formula.

## 8. Type

Use `next/font/local` with bundled self-hosted font files.

Selected sans: `Geist Sans`.

Selected mono: `Geist Mono`.

Use tabular numbers for price, size, time, and rate.

Do not use Inter, Roboto, Arial, or system defaults as the planned visual identity.

Do not use a serif by default. A small brand serif is optional for the wordmark only.

## 9. Component Primitive Strategy

Use Tailwind CSS for layout and tokens. Tailwind is already a confirmed choice.

Use shadcn/ui only as owned source components. Customize every component.

Use Radix primitives only where their behavior fits the control.

| UI need | Primitive |
|---|---|
| Interval switch | `ToggleGroup` |
| Debug tier selection | `Select` or `ToggleGroup` |
| Diagnostics detail | `Tabs` |
| Settings or debug help | `Dialog` |
| Icon explanations | `Tooltip` |
| Binary options | `Switch` |
| Numeric delay input | `Input` |

Do not install Radix Themes. Do not stack multiple design systems.

Source notes:

- shadcn/ui is open code that adds component source to the project. See <https://ui.shadcn.com/docs>.
- shadcn components are listed at <https://ui.shadcn.com/docs/components>.
- Radix Dialog documents focus trapping and screen-reader title support. See <https://www.radix-ui.com/primitives/docs/components/dialog>.
- Radix Tooltip opens on focus and hover. See <https://www.radix-ui.com/primitives/docs/components/tooltip>.
- Radix Toggle Group supports roving focus and arrow keys. See <https://www.radix-ui.com/primitives/docs/components/toggle-group>.

## 10. Screen Layout

### 10.1 Desktop layout, 1440 and wider

Keep the chart central and dominant.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ SYMBOL  PRICE  MOVE       interval controls        LIVE TIER RATE RTT JITTER │
├───────────────┬──────────────────────────────────────────────┬───────────────┤
│ WATCHLIST     │ CHART LEGEND: UTC O H L C V                 │ ORDER BOOK    │
│ optional      │                                              │ asks 10       │
│ reorder       │        CANDLE CHART                          │ spread row    │
│               │        dominant center                       │ bids 10       │
│               │                                              │               │
├───────────────┴──────────────────────────────────────────────┼───────────────┤
│ RECENT TRADES                                                │ DIAGNOSTICS   │
│ latest 20, skipped marker, side text                         │ tier control  │
└──────────────────────────────────────────────────────────────┴───────────────┘
```

Recommended grid:

| Area | Width |
|---|---:|
| Watchlist | 220 px |
| Chart | fluid, minimum 620 px at 1280 px and wider |
| Book | 320 px |
| Bottom trades | chart width |
| Diagnostics | 320 px |

At 1440 px, keep all areas visible.

### 10.2 Desktop layout, 1280 px

Collapse the watchlist into a narrow rail or hide it behind a tab.

Keep the chart and book visible.

```
┌─────────────────────────────────────────────────────────────────────┐
│ SYMBOL PRICE MOVE      intervals          LIVE TIER RATE RTT JITTER │
├─────────────────────────────────────────────┬───────────────────────┤
│ CHART LEGEND                                │ ORDER BOOK            │
│                                             │ 10 asks               │
│ CANDLE CHART                                │ spread                │
│                                             │ 10 bids               │
├─────────────────────────────────────────────┼───────────────────────┤
│ RECENT TRADES                               │ DIAGNOSTICS           │
└─────────────────────────────────────────────┴───────────────────────┘
```

### 10.3 Tablet layout, 1024 px

Use two columns.

Chart stays first. Book stays second.

Recent trades and diagnostics move below.

Use a 320 px book column and a fluid chart column.

At 1024 px, the chart minimum becomes 420 px.

This leaves room for page margins and the 320 px book.

```
┌──────────────────────────────────────────────────────────┐
│ SYMBOL PRICE MOVE       LIVE TIER RATE                   │
├──────────────────────────────────┬───────────────────────┤
│ CHART                            │ ORDER BOOK            │
├──────────────────────────────────┴───────────────────────┤
│ TABS: trades | diagnostics | watchlist                   │
└──────────────────────────────────────────────────────────┘
```

### 10.4 Narrow layout, 768 px

Use one column and sticky status.

Book must still show 10 asks and 10 bids after the chart.

The 20 book rows need a stable minimum height.

A 768 px tall viewport cannot show chart, 20 rows, and lower panels at once.

The user scrolls to the book after the chart.

Within the book panel, rows stay fixed height and readable.

```
┌────────────────────────────────────────────┐
│ SYMBOL PRICE MOVE                          │
│ LIVE TIER RATE RTT                         │
├────────────────────────────────────────────┤
│ Interval controls                          │
├────────────────────────────────────────────┤
│ Chart legend                               │
│ Candlestick chart                          │
├────────────────────────────────────────────┤
│ Order book: 10 asks, spread, 10 bids       │
├────────────────────────────────────────────┤
│ Tabs: trades | diagnostics | watchlist     │
└────────────────────────────────────────────┘
```

### 10.5 Mobile fallback, 390 px

This is a fallback, because the brief targets modern desktop browsers.

Do not hide required data. Stack it.

Use compact rows and horizontal scroll only inside data tables.

The chart height target is 360 px.

The order book shows 10 asks and 10 bids in a compact table.

## 11. Task Flows

### TF1. Open and sync

1. Show `CONNECTING`.
2. After five seconds, show `WAKING` if the server is not ready.
3. Receive `hello`.
4. Start book buffering.
5. Fetch book snapshot and candle history.
6. Show `SYNCING`.
7. Apply buffered deltas.
8. Show `LIVE`.

### TF2. Inspect a candle

1. User hovers, clicks, or drags on the chart.
2. Legend changes from latest candle to inspected candle.
3. Legend shows `UTC`, `O`, `H`, `L`, `C`, and `V`.
4. The selected candle gets a vertical rule.
5. Keyboard users can move the inspection index with arrow keys.

### TF3. Switch interval

1. User selects `1s`, `1m`, or `5m`.
2. Chart enters interval loading state.
3. Old late answers are ignored.
4. Live candles for the old interval are ignored.
5. Legend shows the active interval.

### TF4. Force tier

1. User opens diagnostics.
2. User chooses `auto`, `full`, `degraded`, or `minimal`.
3. UI sends debug command on this WebSocket.
4. Status shows `forced: minimal` and `auto would be: full`.
5. User can return to `auto`.

### TF5. Recover from a book gap

1. User triggers `drop next book delta`.
2. Book panel shows `RESYNCING`.
3. Old book values remain visible but muted.
4. Browser fetches a fresh snapshot.
5. Book returns to `SYNCED`.

### TF6. Recover from disconnect

1. User triggers debug disconnect.
2. UI shows `STALE`.
3. Existing numbers stay visible and muted.
4. Reconnect countdown appears.
5. On reconnect, book and chart resync.
6. After bounded retry exhaustion, show `RECOVERY FAILED`.

## 12. Required Screen States

| State | Visual rule | Copy |
|---|---|---|
| Connecting | Empty chart skeleton, no fake prices | `Connecting` |
| Waking server | Keep shell visible, show patient copy | `Waking the server` |
| Syncing | Data muted, spinner-free skeleton bars | `Syncing book and candles` |
| Live | Cobalt status edge, semantic state text | `Live` |
| Stale | Amber top strip, no price flash | `Stale since 12:03:10 UTC` |
| Reconnecting | Amber strip with timer | `Reconnecting in 4 s` |
| Offline | Amber strip, no aggressive retry loop | `Offline` |
| Feed delayed | Cobalt turns amber, socket may stay open | `Market feed delayed` |
| Recovery failed | Inline retry action, no fake live state | `Unable to synchronize. Retry.` |
| Reload required | Blocking dialog | `New version. Reload the page.` |
| Chart loading | Preserve chart frame height | `Loading 1m history` |
| Empty history | Keep axes and message | `No history yet. Live candles will appear here.` |
| Book resyncing | Keep rows, dim values | `Book resyncing` |
| Book gap | Inline event marker | `Gap detected. Fetching snapshot.` |
| Malformed message | Diagnostics count only | `Bad messages: 3` |
| Hidden tab | No visible screen while hidden | On return, show latest sync state |
| Forced tier | Badge and reason line | `Forced minimal. Auto would be full.` |

## 13. Interaction Details

### 13.1 Top market strip

Show symbol, latest price, absolute move, percent move, and last trade time.

Use `+` and `-` signs, not color alone.

Example: `BTC-USD 64,230.50 +31.00 +0.05%`.

### 13.2 Chart legend

Default legend uses the latest candle.

Inspect legend uses the selected candle.

Always label time as `UTC`.

Legend format:

`12:04:03 UTC  O 64,220.00  H 64,240.50  L 64,210.00  C 64,230.50  V 1.2034`

### 13.3 Order book

Show asks above the spread. Show bids below the spread.

Do not state that bids are always below the latest trade.

Do not state that asks are always above the latest trade.

The invariant is `best bid < best ask`.

Rows use price, size, and depth bar.

Depth bars must not shift row height.

Use labels `ASK` and `BID` in text.

Top 10 asks and top 10 bids must remain visible on desktop.

### 13.4 Recent trades

Show newest first.

Columns: time, price, size, side.

If trades were skipped, show a row marker.

Example: `12 trades skipped at minimal tier`.

### 13.5 Diagnostics

Show these values:

| Value | Unit |
|---|---|
| Active tier | `full`, `degraded`, `minimal` |
| Configured target rate | `10/s`, `2/s`, `0.5/s` ceiling |
| Observed chart rate | chart-bearing `update` messages per second |
| Latency | `ms` |
| Jitter | `ms` |
| Ping timeout count | count in current window |
| Last report age | `s` |
| Last server reason | plain sentence |

Target rate is the configured steady-state ceiling.

Observed rate is the measured count over the stated window.

Label the ceiling as `Configured target`.

Label the measured count as `Observed`.

Timeout count is diagnostic only in version 1.

Example: `Target 2/s. Observed 1.8/s over 10 s.`

### 13.6 Debug controls

Use a compact diagnostics panel. Do not hide it in DevTools.

Controls:

| Control | UI |
|---|---|
| Force tier | segmented toggle or select |
| Pong delay | number input and apply button |
| Drop next book delta | button |
| Disconnect | button |

Each dangerous demo button uses an explicit label. It is still local to the connection.

Do not add a server debug button for empty history.

Empty history is covered by controlled fixtures.

## 14. Motion

Use motion only to explain state.

Allowed:

- Row flash for changed price.
- Short chart loading fade.
- Tier badge transition on tier change.
- Active button press feedback.

Rules:

- Animate only opacity and transform.
- Respect `prefers-reduced-motion`.
- Do not animate the chart background.
- Do not use glow loops.
- Do not use scroll effects.

## 15. Accessibility

Keyboard:

- Tab order follows visual order.
- Interval controls use arrow keys.
- Debug tier control uses keyboard.
- Chart has a keyboard inspection alternative.
- Book and trades can be reached without pointer use.

Screen reader:

- Chart container has a summary.
- Latest candle values are exposed as text.
- Status changes use a polite live region.
- Stale and reload states use assertive announcements.

Non-color signals:

- Buy and sell use text labels.
- Live, stale, syncing, and forced states use words.
- Trend uses `+`, `-`, and text.

Focus:

- Use a visible cobalt focus ring.
- Do not rely on hover-only controls.
- Tooltips must also open on focus.

## 16. Responsive Rules

| Width | Rule |
|---:|---|
| 1440 | Watchlist, chart, book, trades, diagnostics visible |
| 1280 | Watchlist collapses first; diagnostics remains persistent |
| 1024 | Two columns, lower tab strip for diagnostics, trades, watchlist |
| 768 | Single column, chart first, book second |
| 390 | Mobile fallback, compact tables, no hidden required data |

The chart should never become a small preview. It remains the primary view.

## 17. Watchlist Bonus

Watchlist is planned after the graded core.

Planning priority: P11, after the required market screen works.

Use four fixed secondary symbols.

Label the group `Preview only · no market feed`.

Do not show fake prices for secondary symbols.

Only BTC-USD opens the complete simulated market.

The reorder action is still legitimate.

It reorders a saved labelled list, not market data.

Reordering must support keyboard movement.

At 1280 px and below, collapse the watchlist before shrinking the chart.

## 18. Acceptance IDs

### Required content

U01. The first screen is the trading screen.

U02. The latest price and movement are visible above the chart.

U03. The chart is the largest visual area at 1440 px.

U04. The chart supports at least two intervals.

U05. The UI shows 1s, 1m, and 5m if those intervals are implemented.

U06. Candle inspection shows UTC, O, H, L, C, and V.

U07. Top 10 asks and top 10 bids are visible on desktop.

U08. Recent trades are visible without opening DevTools.

U09. Connection status is visible in the top strip.

U10. Active tier and configured target rate are visible.

### Adaptive delivery

U11. The UI shows latency in ms.

U12. The UI shows jitter in ms.

U13. The UI shows ping timeout count as diagnostic data.

U14. The UI shows configured target chart rate.

U15. The UI shows observed chart-bearing update rate.

U16. Forced tier is visible when active.

U17. Auto tier remains visible when forced tier is active.

U18. Returning to auto is one clear action.

### Synchronization and recovery

U19. Stale data remains visible but muted.

U20. Stale state shows when the socket disconnects.

U21. Reconnect state shows a countdown or retry state.

U22. Book resync keeps old values visible and muted.

U23. Book gap recovery shows a short reason.

U24. Interval switch keeps late answers from changing the current chart.

U25. Empty history has a real state, not a broken chart.

U26. Offline, waking, feed-delayed, and recovery-failed states have visible copy.

### Layout

U27. At 1440 px, chart, book, trades, diagnostics, and watchlist can fit.

U28. At 1280 px, chart and book stay visible.

U29. At 1024 px, chart and 320 px book stay side by side.

U30. At 768 px, layout becomes one column.

U31. At 390 px, all required data remains reachable.

U32. At 768 px, 20 book rows remain readable even when scrolling is needed.

### Accessibility

U33. All controls are keyboard reachable.

U34. Focus is visible on all controls.

U35. Tooltip content is also available on focus.

U36. Color is never the only signal.

U37. Reduced motion disables nonessential animation.

U38. Primary text meets WCAG AA contrast.

### Visual quality

U39. The page uses one accent color, cobalt.

U40. The page avoids generic card grids.

U41. The chart has no decorative overlay.

U42. Rows keep stable height during updates.

U43. Numeric columns use tabular figures.

U44. Loading states match final layout shapes.

## 19. Implementation Notes For Later

Use one client screen. Keep networking outside React components.

Use selector-based state reads so frequent updates do not re-render the whole screen.

Use `requestAnimationFrame` batching for UI snapshots.

Use the chart library only for drawing supplied data.

Do not let the chart library fetch or stream market data.

Keep chart setup and cleanup inside an effect.

Keep all timers, sockets, and subscriptions disposable.

## 20. Resolved Design Decisions

RD1. Use the cobalt market instrument visual direction.

RD2. Use bundled `Geist Sans` and `Geist Mono` through `next/font/local`.

RD3. Plan watchlist as P11 after the graded core.

RD4. Keep diagnostics persistent on desktop at 1280 px and wider.

RD5. Move diagnostics into lower tabs at 1024 px and below.

RD6. Display chart time in UTC only.

## 21. Preflight Checklist

- Assignment requirements are visible on the screen.
- Chart is central and dominant.
- No landing page exists before the app.
- No default shadcn styling ships unchanged.
- No second design system is installed.
- No decorative chart overlay exists.
- No hover-only action exists.
- No color-only state exists.
- No huge font download is required.
- All required states have visible copy.

## 22. Contract recheck clarification

A responsive connection alone does not make every panel live.
The runtime tracks producer progress and each panel's applied update progress separately.
Metadata supplies the displayed target rates; the UI does not maintain a second threshold table.
If outbound-budget recovery repeatedly fails, keep values stale and show an explicit Retry action.
The user-facing message explains failed refresh, not internal byte counts or DTO terminology.
