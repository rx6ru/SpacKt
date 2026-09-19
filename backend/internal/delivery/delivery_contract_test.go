package delivery

import (
	"context"
	"errors"
	"testing"
	"time"

	"spackt/internal/model"
)

func TestBookRangeIncludesTouchedLevelWhenQuantityReversesWithinFlush(t *testing.T) {
	source := &stateSource{current: publicationWithBookChanges(12, []model.LevelChange{
		{Seq: 10, Side: model.BookSideBid, PriceTicks: 100, QuantityLots: 1},
		{Seq: 11, Side: model.BookSideBid, PriceTicks: 100, QuantityLots: 2},
		{Seq: 12, Side: model.BookSideBid, PriceTicks: 100, QuantityLots: 1},
	})}
	session := NewSession("conn-a", source, Options{InitialCursors: Cursors{BookSeq: 9}})

	update := selectFrameByKind(t, session.PrepareFlush(1_700_000_000_000).Frames(), FrameUpdate)

	if update.Book == nil {
		t.Fatal("book range missing")
	}
	if !hasLevel(update.Book.Bids, 100, 1) {
		t.Fatalf("book bids = %+v, want touched bid price 100 final quantity 1", update.Book.Bids)
	}
}

func TestBookRangeCoversFirstAndLastTouchedSequence(t *testing.T) {
	source := &stateSource{current: publicationWithBookChanges(14, []model.LevelChange{
		{Seq: 12, Side: model.BookSideBid, PriceTicks: 100, QuantityLots: 3},
		{Seq: 13, Side: model.BookSideAsk, PriceTicks: 103, QuantityLots: 4},
		{Seq: 14, Side: model.BookSideBid, PriceTicks: 99, QuantityLots: 5},
	})}
	session := NewSession("conn-a", source, Options{InitialCursors: Cursors{BookSeq: 11}})

	update := selectFrameByKind(t, session.PrepareFlush(1_700_000_000_000).Frames(), FrameUpdate)

	if update.Book == nil {
		t.Fatal("book range missing")
	}
	if update.Book.From != 12 || update.Book.To != 14 {
		t.Fatalf("book range = %d..%d, want 12..14", update.Book.From, update.Book.To)
	}
}

func TestCandlesResendPreviouslyActiveCandleWhenFinalRevisionChanges(t *testing.T) {
	source := &stateSource{current: publicationWithCandles(20, model.Interval1s, []model.Candle{
		candle(0, 100, 100, 100, 100, 1, 20, false),
	})}
	session := NewSession("conn-a", source, Options{})
	mustCommit(t, mustPrepareSubscribe(t, session, model.Interval1s, 7))
	mustCommit(t, session.PrepareFlush(1_700_000_000_000))

	source.current = publicationWithCandles(21, model.Interval1s, []model.Candle{
		candle(0, 100, 105, 99, 101, 6, 21, true),
		candle(1000, 101, 101, 101, 101, 0, 21, false),
	})

	update := selectFrameByKind(t, session.PrepareFlush(1_700_000_500_000).Frames(), FrameUpdate)

	requireCandleStarts(t, update, 7, model.Interval1s, []int64{0, 1000})
	got := update.Candles.Items[0]
	if !got.Closed || got.Rev != 21 || got.CloseTicks != 101 || got.VolumeLots != 6 {
		t.Fatalf("previous active candle = %+v, want final revision 21 with changed values", got)
	}
}

func TestCandlesIncludeAllClosedBarsBetweenSlowFlushes(t *testing.T) {
	source := &stateSource{current: publicationWithCandles(24, model.Interval1s, []model.Candle{
		candle(0, 100, 100, 100, 100, 1, 20, true),
		candle(1000, 100, 100, 100, 100, 0, 21, true),
		candle(2000, 100, 103, 100, 103, 2, 23, true),
		candle(3000, 103, 103, 103, 103, 0, 24, false),
	})}
	start := Cursors{CandleRequestID: 8, CandleInterval: model.Interval1s, CandleStartMS: 0, CandleRev: 20}
	session := NewSession("conn-a", source, Options{InitialCursors: start})

	update := selectFrameByKind(t, session.PrepareFlush(1_700_000_002_200).Frames(), FrameUpdate)

	requireCandleStarts(t, update, 8, model.Interval1s, []int64{1000, 2000, 3000})
}

func TestExpiredBookCursorEmitsResetWithoutAdvancingBeforeSuccessfulWrite(t *testing.T) {
	source := &stateSource{current: publicationWithBookChanges(5000, logTail(905, 5000))}
	session := NewSession("conn-a", source, Options{BookRetention: 4096, InitialCursors: Cursors{BookSeq: 10}})
	prepared := session.PrepareFlush(1_700_000_000_000)

	reset := selectFrameByKind(t, prepared.Frames(), FrameBookReset)
	if reset.BookReset == nil || reset.BookReset.Reason != "cursor_expired" {
		t.Fatalf("book reset = %+v, want cursor_expired", reset.BookReset)
	}
	if got := session.Cursors().BookSeq; got != 10 {
		t.Fatalf("book cursor advanced before commit: got %d, want 10", got)
	}

	mustCommit(t, prepared)

	if got := session.Cursors().BookSeq; got != 5000 {
		t.Fatalf("book cursor after reset commit = %d, want current seq 5000", got)
	}
}

func TestExpiredCandleCursorEmitsResetWithoutAdvancingBeforeSuccessfulWrite(t *testing.T) {
	source := &stateSource{current: publicationWithCandles(150, model.Interval1s, []model.Candle{
		candle(65_000, 101, 101, 101, 101, 0, 150, false),
	})}
	start := Cursors{CandleRequestID: 12, CandleInterval: model.Interval1s, CandleStartMS: 0, CandleRev: 1}
	session := NewSession("conn-a", source, Options{InitialCursors: start})
	prepared := session.PrepareFlush(1_700_000_000_000)

	reset := selectFrameByKind(t, prepared.Frames(), FrameCandlesReset)
	if reset.CandlesReset == nil || reset.CandlesReset.Reason != "cursor_expired" {
		t.Fatalf("candles reset = %+v, want cursor_expired", reset.CandlesReset)
	}
	if reset.CandlesReset.Interval != model.Interval1s || reset.CandlesReset.RequestID != 12 {
		t.Fatalf("candles reset id/interval = %d/%s, want 12/1s", reset.CandlesReset.RequestID, reset.CandlesReset.Interval)
	}
	if got := session.Cursors().CandleStartMS; got != 0 {
		t.Fatalf("candle cursor advanced before commit: got %d, want 0", got)
	}

	mustCommit(t, prepared)

	if got := session.Cursors().CandleStartMS; got != 65_000 {
		t.Fatalf("candle cursor after reset commit = %d, want latest retained start 65000", got)
	}
}

func TestTradesFrameSendsNewestFiftyAscendingAndReportsSkipped(t *testing.T) {
	source := &stateSource{current: publicationWithTrades(120, trades(1, 120))}
	session := NewSession("conn-a", source, Options{InitialCursors: Cursors{TradeID: 20}})

	update := selectFrameByKind(t, session.PrepareFlush(1_700_000_000_000).Frames(), FrameUpdate)

	if len(update.Trades) != 50 {
		t.Fatalf("trade count = %d, want 50", len(update.Trades))
	}
	if update.Trades[0].ID != 71 || update.Trades[49].ID != 120 {
		t.Fatalf("trade IDs = %d..%d, want 71..120", update.Trades[0].ID, update.Trades[49].ID)
	}
	if update.Skipped != 50 {
		t.Fatalf("skipped = %d, want 50", update.Skipped)
	}
}

func TestOrdinaryWriteFailurePreservesAllCursorsAndClosesLocally(t *testing.T) {
	source := &stateSource{current: publicationWithAllStreams()}
	start := Cursors{BookSeq: 9, TradeID: 2, CandleRequestID: 3, CandleInterval: model.Interval1s, CandleStartMS: 0, CandleRev: 1}
	session := NewSession("conn-a", source, Options{InitialCursors: start})

	_, err := session.PrepareFlush(1_700_000_000_000).Commit(context.Background(), failingSink{err: errors.New("socket write failed")})

	if err == nil {
		t.Fatal("Commit returned nil error for failed sink")
	}
	if got := session.Cursors(); got != start {
		t.Fatalf("cursors after failed write = %+v, want %+v", got, start)
	}
	if code := session.CloseCode(); code != 1006 {
		t.Fatalf("close code = %d, want 1006 after ordinary write failure", code)
	}
	requireTerminalCommitDoesNotWrite(t, session, start)
}

func TestOversizeWriteFailurePreservesCursorsAndClosesWithCode4009(t *testing.T) {
	source := &stateSource{current: publicationWithAllStreams()}
	start := Cursors{BookSeq: 9, TradeID: 2, CandleRequestID: 3, CandleInterval: model.Interval1s, CandleStartMS: 0, CandleRev: 1}
	session := NewSession("conn-a", source, Options{InitialCursors: start})

	_, err := session.PrepareFlush(1_700_000_000_000).Commit(context.Background(), failingSink{err: ErrPayloadTooLarge})

	if !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("Commit error = %v, want ErrPayloadTooLarge", err)
	}
	if got := session.Cursors(); got != start {
		t.Fatalf("cursors after oversize write = %+v, want %+v", got, start)
	}
	if code := session.CloseCode(); code != 4009 {
		t.Fatalf("close code = %d, want 4009", code)
	}
	requireTerminalCommitDoesNotWrite(t, session, start)
}

func TestSubscribeSeedWriteFailurePreservesCursorsAndMakesSessionTerminal(t *testing.T) {
	source := &stateSource{current: publicationWithCandles(80, model.Interval1s, []model.Candle{
		candle(0, 100, 101, 99, 100, 3, 80, false),
	})}
	start := Cursors{BookSeq: 20, TradeID: 5}
	session := NewSession("conn-a", source, Options{InitialCursors: start})
	prepared := mustPrepareSubscribe(t, session, model.Interval1s, 11)
	requireFrameOrder(t, prepared.Frames(), []FrameKind{FrameSubscribed, FrameUpdate})
	if prepared.Frames()[0].Subscribed == nil {
		t.Fatal("first subscribe frame has nil Subscribed payload")
	}
	if prepared.Frames()[0].Subscribed.Interval != model.Interval1s || prepared.Frames()[0].Subscribed.RequestID != 11 {
		t.Fatalf("subscribed id/interval = %d/%s, want 11/1s", prepared.Frames()[0].Subscribed.RequestID, prepared.Frames()[0].Subscribed.Interval)
	}
	sink := &failAtSink{failAt: 2, err: errors.New("seed write failed")}

	_, err := prepared.Commit(context.Background(), sink)

	if err == nil {
		t.Fatal("Commit returned nil error for failed seed write")
	}
	if got := session.Cursors(); got != start {
		t.Fatalf("cursors after failed subscribe seed = %+v, want %+v", got, start)
	}
	if code := session.CloseCode(); code != 1006 {
		t.Fatalf("close code = %d, want 1006 after failed seed write", code)
	}

	requireTerminalCommitDoesNotWrite(t, session, start)
}

func TestTwoConnectionsAdvanceDeliveryCursorsIndependently(t *testing.T) {
	source := &stateSource{current: publicationWithTrades(10, trades(1, 10))}
	a := NewSession("conn-a", source, Options{})
	b := NewSession("conn-b", source, Options{})

	mustCommit(t, a.PrepareFlush(1_700_000_000_000))

	if got := a.Cursors().TradeID; got != 10 {
		t.Fatalf("connection A trade cursor = %d, want 10", got)
	}
	if got := b.Cursors().TradeID; got != 0 {
		t.Fatalf("connection B trade cursor = %d, want 0 before its own flush", got)
	}

	mustCommit(t, b.PrepareFlush(1_700_000_500_000))

	if got := b.Cursors().TradeID; got != 10 {
		t.Fatalf("connection B trade cursor = %d, want 10 after its own flush", got)
	}
}

func TestQuietFlushDoesNotEmitFakeTrade(t *testing.T) {
	source := &stateSource{current: publicationWithCandles(30, model.Interval1s, []model.Candle{
		candle(0, 100, 100, 100, 100, 1, 20, true),
		candle(1000, 100, 100, 100, 100, 0, 21, true),
		candle(2000, 100, 100, 100, 100, 0, 30, false),
	})}
	start := Cursors{CandleRequestID: 4, CandleInterval: model.Interval1s, CandleStartMS: 0, CandleRev: 20, TradeID: 7}
	session := NewSession("conn-a", source, Options{InitialCursors: start})

	update := selectFrameByKind(t, session.PrepareFlush(1_700_000_002_000).Frames(), FrameUpdate)

	if len(update.Trades) != 0 {
		t.Fatalf("quiet flush emitted trades: %+v", update.Trades)
	}
	requireCandleStarts(t, update, 4, model.Interval1s, []int64{1000, 2000})
	if update.Candles.Items[0].VolumeLots != 0 || update.Candles.Items[1].VolumeLots != 0 {
		t.Fatalf("quiet candle volumes = %d,%d, want zero volume", update.Candles.Items[0].VolumeLots, update.Candles.Items[1].VolumeLots)
	}
}

type stateSource struct {
	current model.Publication
}

func (s *stateSource) Current() model.Publication {
	return s.current
}

type failingSink struct {
	err error
}

func (s failingSink) Write(context.Context, Frame) (time.Duration, error) {
	return 0, s.err
}

type failAtSink struct {
	failAt int
	err    error
	writes int
}

func (s *failAtSink) Write(context.Context, Frame) (time.Duration, error) {
	s.writes++
	if s.writes == s.failAt {
		return 0, s.err
	}
	return 10 * time.Millisecond, nil
}

type recordingSink struct {
	frames []Frame
}

func (s *recordingSink) Write(_ context.Context, frame Frame) (time.Duration, error) {
	s.frames = append(s.frames, frame)
	return 10 * time.Millisecond, nil
}

func mustPrepareSubscribe(t *testing.T, session *Session, interval model.CandleInterval, requestID uint64) PreparedFlush {
	t.Helper()
	prepared, err := session.PrepareSubscribe(SubscribeCommand{Interval: interval, RequestID: requestID})
	if err != nil {
		t.Fatalf("PrepareSubscribe returned error: %v", err)
	}
	return prepared
}

func mustCommit(t *testing.T, prepared PreparedFlush) {
	t.Helper()
	if _, err := prepared.Commit(context.Background(), &recordingSink{}); err != nil {
		t.Fatalf("Commit returned error: %v", err)
	}
}

func requireTerminalCommitDoesNotWrite(t *testing.T, session *Session, want Cursors) {
	t.Helper()
	laterSink := &recordingSink{}
	_, laterErr := session.PrepareFlush(1_700_000_000_500).Commit(context.Background(), laterSink)
	if laterErr == nil {
		t.Fatal("terminal session accepted a later commit")
	}
	if len(laterSink.frames) != 0 {
		t.Fatalf("terminal session wrote %d later frame(s), want 0", len(laterSink.frames))
	}
	if got := session.Cursors(); got != want {
		t.Fatalf("cursors after terminal later commit = %+v, want %+v", got, want)
	}
}

func selectFrameByKind(t *testing.T, frames []Frame, kind FrameKind) Frame {
	t.Helper()
	for _, frame := range frames {
		if frame.Kind == kind {
			if frame.Session != "s1" {
				t.Fatalf("%s frame session = %q, want s1", kind, frame.Session)
			}
			return frame
		}
	}
	t.Fatalf("missing %s frame in %+v", kind, frames)
	return Frame{}
}

func requireFrameOrder(t *testing.T, frames []Frame, want []FrameKind) {
	t.Helper()
	if len(frames) != len(want) {
		t.Fatalf("frame count = %d, want %d: %+v", len(frames), len(want), frames)
	}
	for i, kind := range want {
		if frames[i].Kind != kind {
			t.Fatalf("frame %d kind = %s, want %s in %+v", i, frames[i].Kind, kind, frames)
		}
	}
}

func requireCandleStarts(t *testing.T, frame Frame, requestID uint64, interval model.CandleInterval, want []int64) {
	t.Helper()
	if frame.Candles == nil {
		t.Fatal("candle batch missing")
	}
	if frame.Candles.RequestID != requestID || frame.Candles.Interval != interval {
		t.Fatalf("candle batch id/interval = %d/%s, want %d/%s", frame.Candles.RequestID, frame.Candles.Interval, requestID, interval)
	}
	if len(frame.Candles.Items) != len(want) {
		t.Fatalf("candle count = %d, want %d: %+v", len(frame.Candles.Items), len(want), frame.Candles.Items)
	}
	for i, item := range frame.Candles.Items {
		if item.TimeMS != want[i] {
			t.Fatalf("candle %d start = %d, want %d", i, item.TimeMS, want[i])
		}
	}
}

func hasLevel(levels []model.Level, priceTicks int64, quantityLots int64) bool {
	for _, level := range levels {
		if level.PriceTicks == priceTicks && level.QuantityLots == quantityLots {
			return true
		}
	}
	return false
}

func publicationWithBookChanges(bookSeq uint64, changes []model.LevelChange) model.Publication {
	return model.Publication{
		Session:   "s1",
		Symbol:    "BTC-USD",
		MarketRev: bookSeq,
		TimeMS:    1_700_000_000_000 + int64(bookSeq),
		Book: model.BookSnapshot{
			Seq: bookSeq,
		},
		BookChanges:         changes,
		LatestPriceTicks:    100,
		ReferencePriceTicks: 100,
	}
}

func publicationWithCandles(rev uint64, interval model.CandleInterval, candles []model.Candle) model.Publication {
	return model.Publication{
		Session:   "s1",
		Symbol:    "BTC-USD",
		MarketRev: rev,
		TimeMS:    1_700_000_000_000 + int64(rev),
		Book: model.BookSnapshot{
			Seq: 100,
		},
		Candles: map[model.CandleInterval][]model.Candle{
			interval: candles,
		},
		LatestPriceTicks:    100,
		ReferencePriceTicks: 100,
	}
}

func publicationWithTrades(rev uint64, items []model.Trade) model.Publication {
	return model.Publication{
		Session:     "s1",
		Symbol:      "BTC-USD",
		MarketRev:   rev,
		TimeMS:      1_700_000_000_000 + int64(rev),
		Book:        model.BookSnapshot{Seq: 100},
		Trades:      items,
		LastTradeID: items[len(items)-1].ID,
	}
}

func publicationWithAllStreams() model.Publication {
	return model.Publication{
		Session:   "s1",
		Symbol:    "BTC-USD",
		MarketRev: 20,
		TimeMS:    1_700_000_000_020,
		Book:      model.BookSnapshot{Seq: 10},
		BookChanges: []model.LevelChange{
			{Seq: 10, Side: model.BookSideBid, PriceTicks: 100, QuantityLots: 2},
		},
		Candles: map[model.CandleInterval][]model.Candle{
			model.Interval1s: {
				candle(0, 100, 101, 99, 100, 3, 2, true),
				candle(1000, 100, 102, 100, 102, 1, 20, false),
			},
		},
		Trades:              trades(1, 3),
		LastTradeID:         3,
		LatestPriceTicks:    102,
		ReferencePriceTicks: 100,
	}
}

func logTail(first uint64, last uint64) []model.LevelChange {
	changes := make([]model.LevelChange, 0, last-first+1)
	for seq := first; seq <= last; seq++ {
		changes = append(changes, model.LevelChange{
			Seq:          seq,
			Side:         model.BookSideBid,
			PriceTicks:   100 + int64(seq%10),
			QuantityLots: int64(seq % 5),
		})
	}
	return changes
}

func candle(startMS int64, open int64, high int64, low int64, close int64, volume int64, rev uint64, closed bool) model.Candle {
	return model.Candle{
		TimeMS:     startMS,
		OpenTicks:  open,
		HighTicks:  high,
		LowTicks:   low,
		CloseTicks: close,
		VolumeLots: volume,
		Rev:        rev,
		Closed:     closed,
	}
}

func trades(first uint64, last uint64) []model.Trade {
	items := make([]model.Trade, 0, last-first+1)
	for id := first; id <= last; id++ {
		items = append(items, model.Trade{
			ID:           id,
			TimeMS:       1_700_000_000_000 + int64(id),
			PriceTicks:   100 + int64(id),
			QuantityLots: 1,
			Side:         "buy",
		})
	}
	return items
}
