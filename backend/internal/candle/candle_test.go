package candle_test

import (
	"testing"

	"spackt/internal/candle"
	"spackt/internal/model"
)

func TestFirstRealTradeResetsEmptyPlaceholderCandle(t *testing.T) {
	a := candle.New(1000, 10)
	a.Apply(trade(1, 0, 100, 1, "buy"))
	a.Advance(1000)

	changed := a.Apply(trade(2, 1000, 105, 2, "buy"))
	active := findCandle(t, changed, 1000)
	if active.OpenTicks != 105 || active.HighTicks != 105 || active.LowTicks != 105 || active.CloseTicks != 105 || active.VolumeLots != 2 {
		t.Fatalf("first real trade did not reset placeholder: %+v", active)
	}

	changed = a.Apply(trade(3, 1200, 103, 1, "sell"))
	active = findCandle(t, changed, 1000)
	if active.OpenTicks != 105 || active.HighTicks != 105 || active.LowTicks != 103 || active.CloseTicks != 103 || active.VolumeLots != 3 {
		t.Fatalf("second trade did not update reset candle correctly: %+v", active)
	}
}

func TestHandCalculatedOracleProtectsCandleAggregation(t *testing.T) {
	a := candle.New(1000, 10)
	a.Apply(trade(1, 0, 100, 1, "buy"))
	a.Apply(trade(2, 200, 104, 2, "buy"))
	a.Apply(trade(3, 800, 99, 3, "sell"))

	got := onlyCandle(t, a.History(10))
	want := model.Candle{TimeMS: 0, OpenTicks: 100, HighTicks: 104, LowTicks: 99, CloseTicks: 99, VolumeLots: 6, Closed: false}
	assertCandleValues(t, got, want)
}

func TestBucketBoundaryStartsNewCandle(t *testing.T) {
	a := candle.New(1000, 10)
	a.Apply(trade(1, 999, 100, 1, "buy"))
	a.Apply(trade(2, 1000, 101, 1, "buy"))

	history := a.History(10)
	if len(history) != 2 {
		t.Fatalf("history length = %d, want 2", len(history))
	}
	if history[0].TimeMS != 0 || history[1].TimeMS != 1000 {
		t.Fatalf("candle starts = %d,%d, want 0,1000", history[0].TimeMS, history[1].TimeMS)
	}
	if !history[0].Closed || history[1].Closed {
		t.Fatalf("closed flags = %v,%v, want true,false", history[0].Closed, history[1].Closed)
	}
}

func TestEmptyCandleCarriesPreviousCloseWithZeroVolume(t *testing.T) {
	a := candle.New(1000, 10)
	a.Apply(trade(1, 0, 102, 5, "buy"))

	changed := a.Advance(1000)
	empty := findCandle(t, changed, 1000)
	want := model.Candle{TimeMS: 1000, OpenTicks: 102, HighTicks: 102, LowTicks: 102, CloseTicks: 102, VolumeLots: 0, Closed: false}
	assertCandleValues(t, empty, want)
}

func TestAdvanceEmitsEveryClosedCandleAcrossSkippedFlushInterval(t *testing.T) {
	a := candle.New(1000, 10)
	a.Apply(trade(1, 0, 100, 1, "buy"))

	changed := a.Advance(2200)
	starts := candleStarts(changed)
	want := []int64{0, 1000, 2000}
	if !sameInt64s(starts, want) {
		t.Fatalf("changed candle starts = %v, want %v", starts, want)
	}
	if !findCandle(t, changed, 0).Closed || !findCandle(t, changed, 1000).Closed || findCandle(t, changed, 2000).Closed {
		t.Fatalf("closed states after advance to 2200 were not closed, closed, active: %+v", changed)
	}
}

func TestConsecutiveEmptyCandleKeysGetDistinctRevisions(t *testing.T) {
	a := candle.New(1000, 10)
	a.Apply(trade(1, 0, 100, 1, "buy"))

	changed := a.Advance(2000)
	firstEmpty := findCandle(t, changed, 1000)
	secondEmpty := findCandle(t, changed, 2000)
	if firstEmpty.VolumeLots != 0 || secondEmpty.VolumeLots != 0 {
		t.Fatalf("empty volumes = %d,%d, want 0,0", firstEmpty.VolumeLots, secondEmpty.VolumeLots)
	}
	if firstEmpty.Rev == secondEmpty.Rev {
		t.Fatalf("consecutive empty candles share revision %d", firstEmpty.Rev)
	}
}

func TestEveryTradeContributesOnceToEachConfiguredInterval(t *testing.T) {
	oneSecond := candle.New(1000, 10)
	oneMinute := candle.New(60000, 10)
	for _, item := range []model.Trade{
		trade(1, 0, 100, 1, "buy"),
		trade(2, 1000, 101, 2, "buy"),
		trade(3, 2000, 102, 3, "sell"),
	} {
		oneSecond.Apply(item)
		oneMinute.Apply(item)
	}

	minuteCandle := onlyCandle(t, oneMinute.History(10))
	if minuteCandle.VolumeLots != 6 {
		t.Fatalf("1m volume = %d, want 6", minuteCandle.VolumeLots)
	}
	if len(oneSecond.History(10)) != 3 {
		t.Fatalf("1s candle count = %d, want 3", len(oneSecond.History(10)))
	}
}

func TestCrossIntervalClosedCandlesAreNotLost(t *testing.T) {
	oneSecond := candle.New(1000, 100)
	oneMinute := candle.New(60000, 10)
	for _, item := range []model.Trade{
		trade(1, 0, 100, 1, "buy"),
		trade(2, 61000, 105, 1, "buy"),
	} {
		oneSecond.Apply(item)
		oneMinute.Apply(item)
	}

	seconds := oneSecond.History(100)
	minutes := oneMinute.History(10)
	if len(seconds) == 0 || len(minutes) != 2 {
		t.Fatalf("unexpected history lengths: 1s=%d 1m=%d", len(seconds), len(minutes))
	}
	if !minutes[0].Closed || minutes[1].Closed {
		t.Fatalf("minute closed flags = %v,%v, want true,false", minutes[0].Closed, minutes[1].Closed)
	}
}

func TestFiveMinuteAggregatorReceivesTheSameTradeFanout(t *testing.T) {
	fiveMinute := candle.New(300000, 10)
	for _, item := range []model.Trade{
		trade(1, 0, 100, 1, "buy"),
		trade(2, 60000, 103, 2, "buy"),
		trade(3, 240000, 99, 3, "sell"),
	} {
		fiveMinute.Apply(item)
	}

	got := onlyCandle(t, fiveMinute.History(10))
	want := model.Candle{TimeMS: 0, OpenTicks: 100, HighTicks: 103, LowTicks: 99, CloseTicks: 99, VolumeLots: 6, Closed: false}
	assertCandleValues(t, got, want)
}

func TestHistoryRingWrapKeepsAscendingMostRecentCandles(t *testing.T) {
	a := candle.New(1000, 3)
	for i := int64(0); i < 6; i++ {
		a.Apply(trade(uint64(i+1), i*1000, 100+i, 1, "buy"))
	}

	history := a.History(10)
	starts := candleStarts(history)
	want := []int64{3000, 4000, 5000}
	if !sameInt64s(starts, want) {
		t.Fatalf("history starts after retention wrap = %v, want %v", starts, want)
	}
}

func trade(id uint64, timeMS int64, priceTicks int64, quantityLots int64, side string) model.Trade {
	return model.Trade{
		ID:           id,
		TimeMS:       timeMS,
		PriceTicks:   priceTicks,
		QuantityLots: quantityLots,
		Side:         side,
	}
}

func onlyCandle(t *testing.T, candles []model.Candle) model.Candle {
	t.Helper()
	if len(candles) != 1 {
		t.Fatalf("candle count = %d, want 1: %+v", len(candles), candles)
	}
	return candles[0]
}

func findCandle(t *testing.T, candles []model.Candle, startMS int64) model.Candle {
	t.Helper()
	for _, item := range candles {
		if item.TimeMS == startMS {
			return item
		}
	}
	t.Fatalf("missing candle at %d in %+v", startMS, candles)
	return model.Candle{}
}

func assertCandleValues(t *testing.T, got model.Candle, want model.Candle) {
	t.Helper()
	if got.TimeMS != want.TimeMS ||
		got.OpenTicks != want.OpenTicks ||
		got.HighTicks != want.HighTicks ||
		got.LowTicks != want.LowTicks ||
		got.CloseTicks != want.CloseTicks ||
		got.VolumeLots != want.VolumeLots ||
		got.Closed != want.Closed {
		t.Fatalf("candle = %+v, want values %+v", got, want)
	}
}

func candleStarts(candles []model.Candle) []int64 {
	starts := make([]int64, 0, len(candles))
	for _, item := range candles {
		starts = append(starts, item.TimeMS)
	}
	return starts
}

func sameInt64s(a []int64, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
