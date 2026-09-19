package market

import (
	"context"
	"errors"
	"spackt/internal/model"
	"time"
)

type Clock interface {
	Now() time.Time
	Ticks() <-chan time.Time
}

type Config struct {
	Session        string
	Symbol         string
	Seed           int64
	EpochMS        int64
	HistoryMinutes int
	Step           time.Duration
	Retention      Retention
}

type Retention struct {
	HistoryCandles           map[model.CandleInterval]int
	DeliveryClosedCandles    int
	RecentTrades             int
	BookChanges              int
	MaximumBookLevelsPerSide int
}

type Publication = model.Publication

type Owner struct{}
type BookCapture = model.BookCapture

func DefaultConfig() Config                  { return Config{} }
func NewOwner(Config, Clock) (*Owner, error) { return &Owner{}, nil }
func (*Owner) Start(context.Context) error   { return errors.New("not implemented") }
func (*Owner) Close(context.Context) error   { return nil }
func (*Owner) Ready() bool                   { return false }
func (*Owner) Current() model.Publication    { return model.Publication{} }
func (*Owner) CaptureBook(context.Context) (BookCapture, error) {
	return BookCapture{}, errors.New("not implemented")
}
func (*Owner) CaptureHistory(context.Context, model.CandleInterval, int) ([]model.Candle, error) {
	return nil, errors.New("not implemented")
}
func (*Owner) CaptureTrades(context.Context, int) ([]model.Trade, error) {
	return nil, errors.New("not implemented")
}
