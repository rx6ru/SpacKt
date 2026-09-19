package delivery

import (
	"context"
	"errors"
	"spackt/internal/model"
	"time"
)

var (
	ErrNotReady        = errors.New("market is not ready")
	ErrUnknownInterval = errors.New("unsupported candle interval")
	ErrBadRequestID    = errors.New("subscription ID must increase")
	ErrClosed          = errors.New("delivery session is closed")
	ErrSuperseded      = errors.New("prepared delivery was superseded")
)

// Session belongs to one connection owner. Its methods are not concurrent.
type Session struct {
	source    StateSource
	cursors   Cursors
	version   uint64
	closeCode int
}

type PreparedFlush struct {
	session *Session
	version uint64
	next    Cursors
	frames  []Frame
	err     error
}

func NewSession(_ string, source StateSource, options Options) *Session {
	return &Session{source: source, cursors: options.InitialCursors}
}
func (s *Session) Cursors() Cursors { return s.cursors }
func (s *Session) CloseCode() int   { return s.closeCode }

func (s *Session) PrepareSubscribe(cmd SubscribeCommand) (PreparedFlush, error) {
	if s.closeCode != 0 {
		return PreparedFlush{}, ErrClosed
	}
	if cmd.Interval != model.Interval1s && cmd.Interval != model.Interval1m && cmd.Interval != model.Interval5m {
		return PreparedFlush{}, ErrUnknownInterval
	}
	if cmd.RequestID == 0 || cmd.RequestID > 9007199254740991 || cmd.RequestID <= s.cursors.CandleRequestID {
		return PreparedFlush{}, ErrBadRequestID
	}
	pub := s.source.Current()
	if pub.Session == "" {
		return PreparedFlush{}, ErrNotReady
	}
	next := s.cursors
	next.CandleInterval, next.CandleRequestID = cmd.Interval, cmd.RequestID
	next.CandleStartMS, next.CandleRev = 0, 0
	frames := []Frame{{Session: pub.Session, Kind: FrameSubscribed, Subscribed: &SubscribedFrame{Interval: cmd.Interval, RequestID: cmd.RequestID}}}
	if candles := pub.Candles[cmd.Interval]; len(candles) != 0 {
		last := candles[len(candles)-1]
		frames = append(frames, Frame{Session: pub.Session, Kind: FrameUpdate, MarketRev: pub.MarketRev, Candles: &CandleBatch{RequestID: cmd.RequestID, Interval: cmd.Interval, Items: []model.Candle{last}}})
		next.CandleStartMS, next.CandleRev = last.TimeMS, last.Rev
	}
	return PreparedFlush{session: s, version: s.version, next: next, frames: frames}, nil
}

func (s *Session) PrepareFlush(_ int64) PreparedFlush {
	prepared := PreparedFlush{session: s, version: s.version, next: s.cursors}
	if s.closeCode != 0 {
		prepared.err = ErrClosed
		return prepared
	}
	pub := s.source.Current()
	if pub.Session == "" {
		prepared.err = ErrNotReady
		return prepared
	}
	update := Frame{Session: pub.Session, Kind: FrameUpdate, MarketRev: pub.MarketRev}
	bookRange, expired := buildBookRange(pub, s.cursors.BookSeq)
	if expired {
		prepared.frames = append(prepared.frames, Frame{Session: pub.Session, Kind: FrameBookReset, BookReset: &BookResetFrame{Reason: "cursor_expired"}})
		prepared.next.BookSeq = pub.Book.Seq
	} else if bookRange != nil {
		update.Book = bookRange
		prepared.next.BookSeq = bookRange.To
	}
	if s.cursors.CandleRequestID != 0 {
		candles := pub.Candles[s.cursors.CandleInterval]
		items, expired := changedCandles(candles, s.cursors)
		if expired {
			prepared.frames = append(prepared.frames, Frame{Session: pub.Session, Kind: FrameCandlesReset, CandlesReset: &CandlesResetFrame{Interval: s.cursors.CandleInterval, RequestID: s.cursors.CandleRequestID, Reason: "cursor_expired"}})
			last := candles[len(candles)-1]
			prepared.next.CandleStartMS, prepared.next.CandleRev = last.TimeMS, last.Rev
		} else if len(items) != 0 {
			update.Candles = &CandleBatch{Interval: s.cursors.CandleInterval, RequestID: s.cursors.CandleRequestID, Items: items}
			last := items[len(items)-1]
			prepared.next.CandleStartMS, prepared.next.CandleRev = last.TimeMS, last.Rev
		}
	}
	update.Trades, update.Skipped = unseenTrades(pub, s.cursors.TradeID)
	if len(update.Trades) != 0 {
		prepared.next.TradeID = update.Trades[len(update.Trades)-1].ID
	}
	if update.Book != nil || update.Candles != nil || len(update.Trades) != 0 {
		prepared.frames = append(prepared.frames, update)
	}
	return prepared
}

func (p PreparedFlush) Frames() []Frame { return cloneFrames(p.frames) }

func (p PreparedFlush) Commit(ctx context.Context, sink FrameSink) (time.Duration, error) {
	if p.err != nil {
		return 0, p.err
	}
	if p.session == nil || p.session.closeCode != 0 {
		return 0, ErrClosed
	}
	if p.version != p.session.version {
		return 0, ErrSuperseded
	}
	var elapsed time.Duration
	for _, frame := range cloneFrames(p.frames) {
		duration, err := sink.Write(ctx, frame)
		elapsed += duration
		if err != nil {
			p.session.closeCode = 1006 // Local diagnostic only; never transmit reserved code 1006.
			if errors.Is(err, ErrPayloadTooLarge) {
				p.session.closeCode = 4009
			}
			return elapsed, err
		}
	}
	p.session.cursors = p.next
	p.session.version++
	return elapsed, nil
}
