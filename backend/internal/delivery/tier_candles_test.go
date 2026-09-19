package delivery

import (
	"context"
	"fmt"
	"testing"

	candleagg "spackt/internal/candle"
	"spackt/internal/model"
)

func TestAllDeliveryCadencesPreserveHandCalculatedFinalCandles(t *testing.T) {
	for _, tc := range []struct {
		name       string
		interval   model.CandleInterval
		intervalMS int64
		requestID  uint64
	}{
		{name: "1s", interval: model.Interval1s, intervalMS: 1_000, requestID: 101},
		{name: "1m", interval: model.Interval1m, intervalMS: 60_000, requestID: 102},
		{name: "5m", interval: model.Interval5m, intervalMS: 300_000, requestID: 103},
	} {
		t.Run(tc.name, func(t *testing.T) {
			want := handCalculatedFourWindowCandles(tc.intervalMS)
			publications := buildCandlePublications(tc.interval, tc.intervalMS)

			for _, cadenceMS := range []int64{100, 500, 2_000} {
				t.Run(fmt.Sprintf("cadence_%dms", cadenceMS), func(t *testing.T) {
					source := &tierCandleSource{}
					session := NewSession("conn-"+tc.name, source, Options{})
					sink := &recordingSink{}

					source.current = publications[0]
					if _, err := mustPrepareSubscribe(t, session, tc.interval, tc.requestID).Commit(context.Background(), sink); err != nil {
						t.Fatalf("subscribe commit returned error: %v", err)
					}

					var delivered []model.Candle
					for flushAt := int64(0); flushAt <= 4*tc.intervalMS; flushAt += cadenceMS {
						source.current = publicationAtOrBefore(publications, flushAt)
						prepared := session.PrepareFlush(flushAt)
						frames := prepared.Frames()
						for _, frame := range frames {
							if frame.Kind == FrameUpdate && frame.Candles != nil && frame.Candles.RequestID == tc.requestID {
								delivered = mergeCandlesByStart(delivered, frame.Candles.Items)
							}
						}
						if _, err := prepared.Commit(context.Background(), sink); err != nil {
							t.Fatalf("flush commit at %d returned error: %v", flushAt, err)
						}
					}

					gotClosed := closedCandlesThrough(delivered, 3*tc.intervalMS)
					assertExactCandles(t, gotClosed, want)
				})
			}
		})
	}
}

type tierCandleSource struct {
	current model.Publication
}

func (s *tierCandleSource) Current() model.Publication {
	return s.current
}

func buildCandlePublications(interval model.CandleInterval, intervalMS int64) []model.Publication {
	aggregator := candleagg.New(intervalMS, 16)
	trades := fourWindowTrades(intervalMS)
	publications := make([]model.Publication, 0, len(trades)+1)

	for _, trade := range trades {
		aggregator.Apply(trade)
		publications = append(publications, candlePublication(interval, trade.ID, trade.TimeMS, aggregator.History(16)))
	}
	aggregator.Advance(4 * intervalMS)
	publications = append(publications, candlePublication(interval, uint64(len(trades)+1), 4*intervalMS, aggregator.History(16)))

	return publications
}

func fourWindowTrades(intervalMS int64) []model.Trade {
	return []model.Trade{
		{ID: 1, TimeMS: 0, PriceTicks: 100_000, QuantityLots: 10, Side: "buy"},
		{ID: 2, TimeMS: 100, PriceTicks: 105_000, QuantityLots: 20, Side: "buy"},
		{ID: 3, TimeMS: intervalMS - 100, PriceTicks: 99_000, QuantityLots: 30, Side: "sell"},
		{ID: 4, TimeMS: 2*intervalMS + 100, PriceTicks: 110_000, QuantityLots: 40, Side: "buy"},
		{ID: 5, TimeMS: 3*intervalMS - 100, PriceTicks: 107_000, QuantityLots: 50, Side: "sell"},
	}
}

func handCalculatedFourWindowCandles(intervalMS int64) []model.Candle {
	return []model.Candle{
		{TimeMS: 0, OpenTicks: 100_000, HighTicks: 105_000, LowTicks: 99_000, CloseTicks: 99_000, VolumeLots: 60, Closed: true},
		{TimeMS: intervalMS, OpenTicks: 99_000, HighTicks: 99_000, LowTicks: 99_000, CloseTicks: 99_000, VolumeLots: 0, Closed: true},
		{TimeMS: 2 * intervalMS, OpenTicks: 110_000, HighTicks: 110_000, LowTicks: 107_000, CloseTicks: 107_000, VolumeLots: 90, Closed: true},
		{TimeMS: 3 * intervalMS, OpenTicks: 107_000, HighTicks: 107_000, LowTicks: 107_000, CloseTicks: 107_000, VolumeLots: 0, Closed: true},
	}
}

func candlePublication(interval model.CandleInterval, rev uint64, timeMS int64, candles []model.Candle) model.Publication {
	return model.Publication{
		Session:   "s1",
		Symbol:    "BTC-USD",
		MarketRev: rev,
		TimeMS:    timeMS,
		Book:      model.BookSnapshot{Seq: rev},
		Candles: map[model.CandleInterval][]model.Candle{
			interval: candles,
		},
		LatestPriceTicks:    107_000,
		ReferencePriceTicks: 100_000,
	}
}

func publicationAtOrBefore(publications []model.Publication, flushAt int64) model.Publication {
	selected := publications[0]
	for _, publication := range publications {
		if publication.TimeMS <= flushAt {
			selected = publication
		}
	}
	return selected
}

func mergeCandlesByStart(existing []model.Candle, updates []model.Candle) []model.Candle {
	byStart := make(map[int64]model.Candle, len(existing)+len(updates))
	order := make([]int64, 0, len(existing)+len(updates))
	for _, item := range existing {
		byStart[item.TimeMS] = item
		order = append(order, item.TimeMS)
	}
	for _, item := range updates {
		if _, ok := byStart[item.TimeMS]; !ok {
			order = append(order, item.TimeMS)
		}
		byStart[item.TimeMS] = item
	}

	merged := make([]model.Candle, 0, len(order))
	seen := make(map[int64]bool, len(order))
	for _, start := range order {
		if seen[start] {
			continue
		}
		seen[start] = true
		merged = append(merged, byStart[start])
	}
	return merged
}

func closedCandlesThrough(candles []model.Candle, maxStart int64) []model.Candle {
	var closed []model.Candle
	for _, item := range candles {
		if item.Closed && item.TimeMS <= maxStart {
			closed = append(closed, item)
		}
	}
	return closed
}

func assertExactCandles(t *testing.T, got []model.Candle, want []model.Candle) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("closed candle count = %d, want %d\ngot:  %+v\nwant: %+v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i].TimeMS != want[i].TimeMS ||
			got[i].OpenTicks != want[i].OpenTicks ||
			got[i].HighTicks != want[i].HighTicks ||
			got[i].LowTicks != want[i].LowTicks ||
			got[i].CloseTicks != want[i].CloseTicks ||
			got[i].VolumeLots != want[i].VolumeLots ||
			got[i].Closed != want[i].Closed {
			t.Fatalf("closed candle %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}
