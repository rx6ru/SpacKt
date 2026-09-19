package model

type Trade struct {
	ID           uint64
	TimeMS       int64
	PriceTicks   int64
	QuantityLots int64
	Side         string
}
