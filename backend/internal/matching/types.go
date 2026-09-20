package matching

import "spackt/internal/model"

type Side string

const (
	Buy  Side = "buy"
	Sell Side = "sell"
)

type Limits struct {
	MinPriceTicks int64
	MaxPriceTicks int64
	MaxOrderLots  int64
	MaxLevelLots  int64
	MaxOrders     int
}

type Order struct {
	ID            uint64
	Side          Side
	PriceTicks    int64
	RemainingLots int64
}

type Fill struct {
	MakerOrderID uint64
	PriceTicks   int64
	QuantityLots int64
}

type Result struct {
	OrderID       uint64
	RemainingLots int64
	Fills         []Fill
	BookChanges   []model.LevelChange
}
