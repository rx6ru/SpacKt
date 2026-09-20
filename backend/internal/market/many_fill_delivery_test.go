package market

import (
	"testing"
	"time"

	"spackt/internal/delivery"
	"spackt/internal/model"
	"spackt/internal/sim"
	"spackt/internal/transport/wire"
)

func TestSingleEventWith1024FillsFeedsCandlesBeforeRecentTapeCaps(t *testing.T) {
	owner := newManyFillOwner()
	event := manyFillEvent(1, 0, 1_024)

	owner.applyEvent(event)
	owner.publish(time.UnixMilli(event.TimeMS))
	pub := owner.Current()

	if pub.LastTradeID != 1_024 {
		t.Fatalf("LastTradeID = %d, want final fill ID 1024", pub.LastTradeID)
	}
	if pub.LatestPriceTicks != 19_951 {
		t.Fatalf("LatestPriceTicks = %d, want final fill price 19951", pub.LatestPriceTicks)
	}
	if len(pub.Trades) != 200 {
		t.Fatalf("owner retained trades = %d, want recent tape cap 200", len(pub.Trades))
	}
	if pub.Trades[0].ID != 825 || pub.Trades[199].ID != 1_024 {
		t.Fatalf("owner retained trade IDs = %d..%d, want 825..1024", pub.Trades[0].ID, pub.Trades[199].ID)
	}

	for _, interval := range []model.CandleInterval{model.Interval1s, model.Interval1m, model.Interval5m} {
		candle := requireCandleAt(t, pub.Candles[interval], 0)
		requireCandleValue(t, interval, candle, model.Candle{
			TimeMS:     0,
			OpenTicks:  20_000,
			HighTicks:  20_000,
			LowTicks:   19_951,
			CloseTicks: 19_951,
			VolumeLots: 1_024,
			Rev:        1,
			Closed:     false,
		})
	}

	session := delivery.NewSession("conn-many-fill", staticPublicationSource{pub: pub}, delivery.Options{InitialCursors: delivery.Cursors{CandleRequestID: 7, CandleInterval: model.Interval1s}})
	update := requireDeliveryUpdate(t, session.PrepareFlush(pub.TimeMS).Frames())
	if update.Book == nil {
		t.Fatalf("delivery update missing book range")
	}
	if update.Book.From != 1 || update.Book.To != 1_024 {
		t.Fatalf("delivery book range = %d..%d, want 1..1024", update.Book.From, update.Book.To)
	}
	if len(update.Book.Bids) != 50 {
		t.Fatalf("coalesced bid changes = %d, want 50", len(update.Book.Bids))
	}
	if update.Book.Bids[0] != (model.Level{PriceTicks: 20_000, QuantityLots: 100}) || update.Book.Bids[49] != (model.Level{PriceTicks: 19_951, QuantityLots: 100}) {
		t.Fatalf("coalesced bid edge levels = %+v ... %+v, want final 50-level book values", update.Book.Bids[0], update.Book.Bids[49])
	}

	if len(update.Trades) != 50 {
		t.Fatalf("delivery trades = %d, want newest cap 50", len(update.Trades))
	}
	if update.Trades[0].ID != 975 || update.Trades[49].ID != 1_024 {
		t.Fatalf("delivery trade IDs = %d..%d, want 975..1024", update.Trades[0].ID, update.Trades[49].ID)
	}
	if update.Skipped != 974 {
		t.Fatalf("delivery skipped = %d, want 974 omitted older fills", update.Skipped)
	}

	if update.Candles == nil || len(update.Candles.Items) != 1 {
		t.Fatalf("delivery update candles = %+v, want one changed candle", update.Candles)
	}
	message := wire.UpdateMessage(pub.Session, wire.UpdateValues{
		MarketRev: update.MarketRev,
		Book:      &wire.BookValues{From: update.Book.From, To: update.Book.To, Bids: update.Book.Bids, Asks: update.Book.Asks},
		Candles:   &wire.CandleValues{RequestID: update.Candles.RequestID, Interval: update.Candles.Interval, Items: update.Candles.Items},
		Trades:    update.Trades,
		Skipped:   update.Skipped,
	})
	if _, err := wire.Encode("server", message); err != nil {
		t.Fatalf("wire encoder rejected capped many-fill update: %v", err)
	}
}

func newManyFillOwner() *Owner {
	cfg := normalizeConfig(Config{
		Session: "many-fill-session",
		Symbol:  "BTC-USD",
		Retention: Retention{
			HistoryCandles: map[model.CandleInterval]int{
				model.Interval1s: 10,
				model.Interval1m: 10,
				model.Interval5m: 10,
			},
			DeliveryClosedCandles:    4,
			RecentTrades:             200,
			BookChanges:              2_048,
			MaximumBookLevelsPerSide: 20,
		},
	})
	return &Owner{cfg: cfg, aggs: newAggregators(cfg.Retention.HistoryCandles), revs: make(map[candleKey]uint64)}
}

func manyFillEvent(rev uint64, timeMS int64, fills int) sim.Event {
	levelFillCounts := make([]int, 50)
	for level := range levelFillCounts {
		levelFillCounts[level] = 20
		if level < 24 {
			levelFillCounts[level]++
		}
	}
	remaining := make([]int64, 50)
	for level, count := range levelFillCounts {
		remaining[level] = int64(100 + count)
	}

	trades := make([]model.Trade, 0, fills)
	changes := make([]model.LevelChange, 0, fills)
	for level, count := range levelFillCounts {
		price := 20_000 - int64(level)
		for i := 0; i < count; i++ {
			remaining[level]--
			id := uint64(len(trades) + 1)
			trades = append(trades, model.Trade{ID: id, TimeMS: timeMS, PriceTicks: price, QuantityLots: 1, Side: "sell"})
			changes = append(changes, model.LevelChange{Seq: id, Side: model.BookSideBid, PriceTicks: price, QuantityLots: remaining[level]})
		}
	}
	if len(trades) != fills {
		panic("manyFillEvent fixture fill count mismatch")
	}

	bids := make([]model.Level, 0, 50)
	for level := 0; level < 50; level++ {
		bids = append(bids, model.Level{PriceTicks: 20_000 - int64(level), QuantityLots: remaining[level]})
	}
	asks := make([]model.Level, 0, 50)
	for i := 0; i < 50; i++ {
		asks = append(asks, model.Level{PriceTicks: 20_001 + int64(i), QuantityLots: int64(100 + i)})
	}
	return sim.Event{
		Rev:         rev,
		TimeMS:      timeMS,
		Trades:      trades,
		BookChanges: changes,
		Book:        model.BookSnapshot{Seq: uint64(fills), Bids: bids, Asks: asks},
	}
}

type staticPublicationSource struct{ pub model.Publication }

func (s staticPublicationSource) Current() model.Publication { return s.pub }

func requireDeliveryUpdate(t *testing.T, frames []delivery.Frame) delivery.Frame {
	t.Helper()
	for _, frame := range frames {
		if frame.Kind == delivery.FrameUpdate {
			return frame
		}
	}
	t.Fatalf("no update frame in %+v", frames)
	return delivery.Frame{}
}
