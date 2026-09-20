package market

import (
	"reflect"
	"testing"
	"time"

	"spackt/internal/model"
	"spackt/internal/sim"
)

func TestApplyEventRecordsAllFillsAndFinalLatestState(t *testing.T) {
	owner := newHandEventOwner()
	event := handManyFillEvent(1, 0)

	owner.applyEvent(event)
	owner.publish(time.UnixMilli(event.TimeMS))
	pub := owner.Current()

	requireTrades(t, pub.Trades, event.Trades)
	if pub.LastTradeID != 3 {
		t.Fatalf("LastTradeID = %d, want final fill ID 3", pub.LastTradeID)
	}
	if pub.LatestPriceTicks != 10_100 {
		t.Fatalf("LatestPriceTicks = %d, want final fill price 10100", pub.LatestPriceTicks)
	}
	if pub.ReferencePriceTicks != 10_100 {
		t.Fatalf("ReferencePriceTicks = %d, want warmup latest fill price 10100", pub.ReferencePriceTicks)
	}
}

func TestApplyEventUsesEveryFillForCandleOHLCVAcrossIntervals(t *testing.T) {
	owner := newHandEventOwner()
	event := handManyFillEvent(1, 0)

	owner.applyEvent(event)
	owner.publish(time.UnixMilli(event.TimeMS))
	pub := owner.Current()

	for _, interval := range []model.CandleInterval{model.Interval1s, model.Interval1m, model.Interval5m} {
		candle := requireCandleAt(t, pub.Candles[interval], 0)
		requireCandleValue(t, interval, candle, model.Candle{
			TimeMS:     0,
			OpenTicks:  10_102,
			HighTicks:  10_102,
			LowTicks:   10_100,
			CloseTicks: 10_100,
			VolumeLots: 6,
			Rev:        1,
			Closed:     false,
		})
	}
}

func TestApplyEventBoundaryFillsClosePreviousBucketAndAdvanceEmptyBucket(t *testing.T) {
	owner := newHandEventOwner()
	owner.applyEvent(sim.Event{
		Rev:    1,
		TimeMS: 0,
		Trades: []model.Trade{{
			ID: 1, TimeMS: 0, PriceTicks: 10_103, QuantityLots: 2, Side: "sell",
		}},
		Book: model.BookSnapshot{Seq: 1},
	})
	owner.applyEvent(sim.Event{
		Rev:    2,
		TimeMS: 1_000,
		Trades: []model.Trade{
			{ID: 2, TimeMS: 1_000, PriceTicks: 10_103, QuantityLots: 1, Side: "sell"},
			{ID: 3, TimeMS: 1_000, PriceTicks: 10_100, QuantityLots: 3, Side: "sell"},
		},
		Book: model.BookSnapshot{Seq: 2},
	})
	owner.applyEvent(sim.Event{Rev: 3, TimeMS: 2_000, Book: model.BookSnapshot{Seq: 2}})
	owner.publish(time.UnixMilli(2_000))
	pub := owner.Current()

	first := requireCandleAt(t, pub.Candles[model.Interval1s], 0)
	if !first.Closed || first.Rev != 2 {
		t.Fatalf("first 1s candle = %+v, want closed with event rev 2", first)
	}
	second := requireCandleAt(t, pub.Candles[model.Interval1s], 1_000)
	if !second.Closed || second.OpenTicks != 10_103 || second.HighTicks != 10_103 || second.LowTicks != 10_100 ||
		second.CloseTicks != 10_100 || second.VolumeLots != 4 || second.Rev != 3 {
		t.Fatalf("second 1s candle = %+v, want boundary fill OHLCV closed at rev 3", second)
	}
	empty := requireCandleAt(t, pub.Candles[model.Interval1s], 2_000)
	if empty.Closed || empty.VolumeLots != 0 || empty.OpenTicks != 10_100 || empty.CloseTicks != 10_100 || empty.Rev != 3 {
		t.Fatalf("empty advanced 1s candle = %+v, want active no-trade carry-forward at rev 3", empty)
	}
}

func TestApplyEventPublishesOwnedCopiesOfManyFillTradesAndBookChanges(t *testing.T) {
	owner := newHandEventOwner()
	event := handManyFillEvent(1, 0)

	owner.applyEvent(event)
	owner.publish(time.UnixMilli(event.TimeMS))
	pub := owner.Current()
	if len(pub.Trades) == 0 {
		t.Fatalf("publication has no trades to test ownership; want many-fill event trades")
	}
	if len(pub.BookChanges) == 0 {
		t.Fatalf("publication has no book changes to test ownership")
	}
	pub.Trades[0].ID = 999
	pub.BookChanges[0].Seq = 999

	fresh := owner.Current()
	if fresh.Trades[0].ID == 999 {
		t.Fatalf("mutating returned trades changed owner state")
	}
	if fresh.BookChanges[0].Seq == 999 {
		t.Fatalf("mutating returned book changes changed owner state")
	}
}

func newHandEventOwner() *Owner {
	cfg := normalizeConfig(Config{
		Session: "hand-event-session",
		Symbol:  "BTC-USD",
		Retention: Retention{
			HistoryCandles: map[model.CandleInterval]int{
				model.Interval1s: 10,
				model.Interval1m: 10,
				model.Interval5m: 10,
			},
			DeliveryClosedCandles:    4,
			RecentTrades:             20,
			BookChanges:              20,
			MaximumBookLevelsPerSide: 20,
		},
	})
	return &Owner{
		cfg:  cfg,
		aggs: newAggregators(cfg.Retention.HistoryCandles),
		revs: make(map[candleKey]uint64),
	}
}

func handManyFillEvent(rev uint64, timeMS int64) sim.Event {
	event := sim.Event{
		Rev:    rev,
		TimeMS: timeMS,
		Trades: []model.Trade{
			{ID: 1, TimeMS: timeMS, PriceTicks: 10_102, QuantityLots: 1, Side: "sell"},
			{ID: 2, TimeMS: timeMS, PriceTicks: 10_101, QuantityLots: 2, Side: "sell"},
			{ID: 3, TimeMS: timeMS, PriceTicks: 10_100, QuantityLots: 3, Side: "sell"},
		},
		Book: model.BookSnapshot{
			Seq: 3,
			Bids: []model.Level{
				{PriceTicks: 10_100, QuantityLots: 4},
			},
			Asks: []model.Level{
				{PriceTicks: 10_103, QuantityLots: 5},
			},
		},
	}
	setEventBookChanges(&event, []model.LevelChange{
		{Seq: 1, Side: model.BookSideBid, PriceTicks: 10_102, QuantityLots: 0},
		{Seq: 2, Side: model.BookSideBid, PriceTicks: 10_101, QuantityLots: 0},
		{Seq: 3, Side: model.BookSideBid, PriceTicks: 10_100, QuantityLots: 4},
	})
	return event
}

func setEventBookChanges(event *sim.Event, changes []model.LevelChange) {
	field := reflect.ValueOf(event).Elem().FieldByName("BookChanges")
	slice := reflect.MakeSlice(field.Type(), len(changes), len(changes))
	for i, change := range changes {
		item := slice.Index(i)
		item.FieldByName("Seq").SetUint(change.Seq)
		side := item.FieldByName("Side")
		if side.Kind() == reflect.String {
			side.SetString(string(change.Side))
		} else {
			side.Set(reflect.ValueOf(change.Side).Convert(side.Type()))
		}
		item.FieldByName("PriceTicks").SetInt(change.PriceTicks)
		item.FieldByName("QuantityLots").SetInt(change.QuantityLots)
	}
	field.Set(slice)
}

func requireTrades(t *testing.T, got []model.Trade, want []model.Trade) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("trades length = %d, want %d; trades=%+v", len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("trade[%d] = %+v, want %+v", index, got[index], want[index])
		}
	}
}

func requireCandleAt(t *testing.T, candles []model.Candle, timeMS int64) model.Candle {
	t.Helper()
	var found model.Candle
	matches := 0
	for _, candle := range candles {
		if candle.TimeMS == timeMS {
			found = candle
			matches++
		}
	}
	if matches != 1 {
		t.Fatalf("candle entries at %d = %d, want exactly one final same-revision entry in %+v", timeMS, matches, candles)
	}
	return found
}

func requireCandleValue(t *testing.T, interval model.CandleInterval, got model.Candle, want model.Candle) {
	t.Helper()
	if got.TimeMS != want.TimeMS ||
		got.OpenTicks != want.OpenTicks ||
		got.HighTicks != want.HighTicks ||
		got.LowTicks != want.LowTicks ||
		got.CloseTicks != want.CloseTicks ||
		got.VolumeLots != want.VolumeLots ||
		got.Closed != want.Closed {
		t.Fatalf("%s candle = %+v, want %+v", interval, got, want)
	}
	if got.Rev != want.Rev {
		t.Fatalf("%s candle rev = %d, want %d for final same-revision state", interval, got.Rev, want.Rev)
	}
}
