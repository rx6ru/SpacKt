package model

type Trade struct {
	ID           uint64
	TimeMS       int64
	PriceTicks   int64
	QuantityLots int64
	Side         string // "buy" or "sell"
}

type Level struct {
	PriceTicks   int64
	QuantityLots int64
}

type BookSnapshot struct {
	Seq  uint64
	Bids []Level // descending price
	Asks []Level // ascending price
}

type Candle struct {
	TimeMS     int64
	OpenTicks  int64
	HighTicks  int64
	LowTicks   int64
	CloseTicks int64
	VolumeLots int64
	Rev        uint64
	Closed     bool
}
