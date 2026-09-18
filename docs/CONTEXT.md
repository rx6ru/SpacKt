# SpacKt market-data context

This glossary defines product terms. It does not select implementation mechanisms.

**Market**: The simulated buying and selling activity for one symbol.
Avoid: exchange platform, because this product does not provide actual user trading.

**Symbol**: The label identifying the asset and the currency used to express its price.

**Trade**: One completed simulated exchange with a price, quantity, time, and ordering identifier.
Avoid: order, because an order can remain unfilled.

**Bid**: Waiting interest to buy at a stated price.

**Ask**: Waiting interest to sell at a stated price.

**Price level**: The total waiting quantity on one side at one price.

**Order book**: The current buying and selling price levels.

**Spread**: The best ask price minus the best bid price.

**Candle**: The open, high, low, close, and traded volume for one time interval.

**Active candle**: The candle whose interval has not finished.

**Closed candle**: A finished interval's candle under the simulation's event-time rules.

**Empty candle**: A chosen display summary for an interval with no trades, carrying the prior close and zero volume.

**Snapshot**: A complete consistent copy of the relevant market state at one identified boundary.

**Book range**: An ordered update covering a consecutive interval of book-change numbers.

**Session**: One continuous run of the generated market.

**Delivery tier**: The full, degraded, or minimal policy controlling one connection's delivery timing.
Avoid: data-quality tier, because candle arithmetic remains unchanged.

**Target rate**: The configured steady-state delivery ceiling for a connection.

**Observed rate**: Chart-bearing update messages received during the stated measurement window divided by its elapsed time.

**Stale**: Cached information whose current validity has not been established.

**Resyncing**: Rebuilding trustworthy local data after a detected loss of continuity.

**Feed delayed**: Producer progress is not recent enough to claim current market information, even if the connection responds.

**Forced tier**: A per-connection debug override of normal visible automatic delivery.
