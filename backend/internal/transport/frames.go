package transport

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/coder/websocket"
	"spackt/internal/delivery"
	"spackt/internal/transport/wire"
)

type socketSink struct {
	conn         *websocket.Conn
	marketBudget int
}

func (s socketSink) Write(ctx context.Context, frame delivery.Frame) (time.Duration, error) {
	value, err := frameValue(frame)
	if err != nil {
		slog.Error("WebSocket frame encoding failed", "kind", frame.Kind, "error", err)
		return 0, err
	}
	limit := 1 << 20
	if frame.Kind == delivery.FrameUpdate {
		limit = s.marketBudget
	}
	data, err := wire.EncodeBounded("server", value, limit)
	if errors.Is(err, wire.ErrMessageTooLarge) {
		return 0, delivery.ErrPayloadTooLarge
	}
	if err != nil {
		slog.Error("WebSocket frame encoding failed", "kind", frame.Kind, "error", err)
		return 0, err
	}
	start := time.Now()
	err = s.conn.Write(ctx, websocket.MessageText, data)
	return time.Since(start), err
}

func frameValue(frame delivery.Frame) (map[string]any, error) {
	switch frame.Kind {
	case delivery.FrameHello, delivery.FrameTier:
		if frame.Policy == nil {
			return nil, errors.New("missing delivery policy")
		}
		p := frame.Policy
		values := wire.PolicyValues{Tier: p.Effective, AutoTier: p.Auto, Forced: p.Forced, Hidden: p.Hidden, FlushMS: p.FlushMS, Reason: p.Reason}
		if frame.Kind == delivery.FrameHello {
			return wire.HelloMessage(frame.Session, frame.ConnID, values), nil
		}
		return wire.TierMessage(frame.Session, values), nil
	case delivery.FramePong:
		return wire.PongMessage(frame.Session, frame.PongID), nil
	case delivery.FrameSubscribed:
		if frame.Subscribed == nil {
			return nil, errors.New("missing subscription acknowledgement")
		}
		return wire.SubscribedMessage(frame.Session, frame.Subscribed.Interval, frame.Subscribed.RequestID), nil
	case delivery.FrameBookReset:
		if frame.BookReset == nil {
			return nil, errors.New("missing book reset")
		}
		return wire.BookResetMessage(frame.Session, frame.BookReset.Reason), nil
	case delivery.FrameCandlesReset:
		if frame.CandlesReset == nil {
			return nil, errors.New("missing candle reset")
		}
		c := frame.CandlesReset
		return wire.CandleResetMessage(frame.Session, c.Interval, c.RequestID, c.Reason), nil
	case delivery.FrameHeartbeat:
		if frame.Heartbeat == nil {
			return nil, errors.New("missing heartbeat")
		}
		h := frame.Heartbeat
		return wire.HeartbeatMessage(frame.Session, h.MarketRev, h.BookSeq, h.CandleRequestID, h.CandleLatestRev, h.FeedReady), nil
	case delivery.FrameError:
		if frame.Error == nil {
			return nil, errors.New("missing error details")
		}
		return wire.ErrorMessage(frame.Session, frame.Error.Code, frame.Error.Message), nil
	case delivery.FrameUpdate:
		values := wire.UpdateValues{MarketRev: frame.MarketRev, Trades: frame.Trades, Skipped: frame.Skipped}
		if b := frame.Book; b != nil {
			values.Book = &wire.BookValues{From: b.From, To: b.To, Bids: b.Bids, Asks: b.Asks}
		}
		if c := frame.Candles; c != nil {
			values.Candles = &wire.CandleValues{RequestID: c.RequestID, Interval: c.Interval, Items: c.Items}
		}
		return wire.UpdateMessage(frame.Session, values), nil
	default:
		return nil, fmt.Errorf("unsupported delivery frame %q", frame.Kind)
	}
}
