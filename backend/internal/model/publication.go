package model

type BookSide string

const (
	BookSideBid BookSide = "bid"
	BookSideAsk BookSide = "ask"
)

type LevelChange struct {
	Seq          uint64
	Side         BookSide
	PriceTicks   int64
	QuantityLots int64
}

type CandleInterval string

const (
	Interval1s CandleInterval = "1s"
	Interval1m CandleInterval = "1m"
	Interval5m CandleInterval = "5m"
)

type Publication struct {
	Session             string
	Symbol              string
	MarketRev           uint64
	TimeMS              int64
	Book                BookSnapshot
	BookChanges         []LevelChange
	Candles             map[CandleInterval][]Candle
	Trades              []Trade
	LastTradeID         uint64
	LatestPriceTicks    int64
	ReferencePriceTicks int64
}

type BookCapture struct {
	Session string
	Symbol  string
	TimeMS  int64
	Book    BookSnapshot
}
