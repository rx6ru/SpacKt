package delivery

import (
	"context"
	"errors"
	"spackt/internal/model"
	"time"
)

type StateSource interface {
	Current() model.Publication
}

type FrameSink interface {
	Write(ctx context.Context, frame Frame) (time.Duration, error)
}

var ErrPayloadTooLarge = errors.New("payload too large")

type Options struct {
	InitialCursors Cursors
}

type Cursors struct {
	BookSeq         uint64
	TradeID         uint64
	CandleRequestID uint64
	CandleInterval  model.CandleInterval
	CandleStartMS   int64
	CandleRev       uint64
}

type FrameKind string

const (
	FrameHello        FrameKind = "hello"
	FrameSubscribed   FrameKind = "subscribed"
	FramePong         FrameKind = "pong"
	FrameUpdate       FrameKind = "update"
	FrameTier         FrameKind = "tier"
	FrameHeartbeat    FrameKind = "heartbeat"
	FrameBookReset    FrameKind = "book_reset"
	FrameCandlesReset FrameKind = "candles_reset"
	FrameError        FrameKind = "error"
)

type Frame struct {
	Session      string
	Kind         FrameKind
	ConnID       string
	MarketRev    uint64
	Policy       *PolicyStatus
	PongID       uint64
	Heartbeat    *Heartbeat
	Error        *Error
	Subscribed   *SubscribedFrame
	BookReset    *BookResetFrame
	CandlesReset *CandlesResetFrame
	Book         *BookRange
	Candles      *CandleBatch
	Trades       []model.Trade
	Skipped      uint64
}

type PolicyStatus struct {
	Effective string
	Auto      string
	Forced    *string
	Hidden    bool
	FlushMS   int
	Reason    string
}

type Heartbeat struct {
	MarketRev       uint64
	BookSeq         uint64
	CandleRequestID *uint64
	CandleLatestRev *uint64
	FeedReady       bool
}

type Error struct {
	Code    string
	Message string
}

type SubscribedFrame struct {
	Interval  model.CandleInterval
	RequestID uint64
}

type BookResetFrame struct {
	Reason string
}

type CandlesResetFrame struct {
	Interval  model.CandleInterval
	RequestID uint64
	Reason    string
}

type BookRange struct {
	From uint64
	To   uint64
	Bids []model.Level
	Asks []model.Level
}

type CandleBatch struct {
	RequestID uint64
	Interval  model.CandleInterval
	Items     []model.Candle
}

type SubscribeCommand struct {
	Interval  model.CandleInterval
	RequestID uint64
}
