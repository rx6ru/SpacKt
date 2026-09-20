package sim_test

import (
	"reflect"
	"testing"

	"spackt/internal/model"
	"spackt/internal/sim"
)

func TestReplayIsIdenticalWhenSeedAndEpochMatch(t *testing.T) {
	a := sim.New(testConfig(7, 1700000000000))
	b := sim.New(testConfig(7, 1700000000000))

	for i := 0; i < 1000; i++ {
		left := a.Next()
		right := b.Next()
		if !reflect.DeepEqual(left, right) {
			t.Fatalf("event %d differs for same seed and epoch:\nleft=%+v\nright=%+v", i, left, right)
		}
	}
}

func TestReplayShiftsAbsoluteTimesWhenOnlyEpochChanges(t *testing.T) {
	a := sim.New(testConfig(7, 1700000000000))
	b := sim.New(testConfig(7, 1700000001000))

	for i := 0; i < 200; i++ {
		left := a.Next()
		right := b.Next()
		if right.TimeMS-left.TimeMS != 1000 {
			t.Fatalf("event %d time shift = %d, want 1000", i, right.TimeMS-left.TimeMS)
		}
		normalized := normalizeEventTime(right, 1000)
		if !reflect.DeepEqual(left, normalized) {
			t.Fatalf("event %d differs after normalizing epoch shift:\nleft=%+v\nnormalized=%+v", i, left, normalized)
		}
	}
}

func TestTradeIDsIncreaseWithoutGaps(t *testing.T) {
	s := sim.New(testConfig(11, 1700000000000))
	var want uint64 = 1

	for i := 0; i < 10000 && want <= 100; i++ {
		event := s.Next()
		for _, trade := range event.Trades {
			if trade.ID != want {
				t.Fatalf("trade ID = %d, want %d", trade.ID, want)
			}
			want++
		}
	}
	if want <= 100 {
		t.Fatalf("generated %d trades in 10000 events, want 100", want-1)
	}
}

func TestEventBookSnapshotStaysSortedPositiveAndUncrossedAfterManyEvents(t *testing.T) {
	s := sim.New(testConfig(21, 1700000000000))

	for i := 0; i < 10000; i++ {
		event := s.Next()
		assertBookInvariant(t, event.Book)
	}
}

func TestSimulatorClampsLowConfiguredMidpointInsidePriceRange(t *testing.T) {
	s := sim.New(sim.Config{
		Seed:     31,
		EpochMS:  1700000000000,
		MidTicks: 1,
		StepMS:   100,
	})

	for i := 0; i < 200; i++ {
		event := s.Next()
		assertEventWithinSimulatorBounds(t, event)
	}
}

func TestSimulatorClampsHighConfiguredMidpointInsidePriceRange(t *testing.T) {
	s := sim.New(sim.Config{
		Seed:     37,
		EpochMS:  1700000000000,
		MidTicks: 100000000,
		StepMS:   100,
	})

	for i := 0; i < 200; i++ {
		event := s.Next()
		assertEventWithinSimulatorBounds(t, event)
	}
}

func TestTradeQuantityNeverExceedsAppliedBookAvailability(t *testing.T) {
	s := sim.New(testConfig(29, 1700000000000))
	previous := s.Next().Book

	for i := 1; i < 2000; i++ {
		event := s.Next()
		if len(event.Trades) > 0 {
			assertTradesConsumeAvailableLiquidity(t, previous, event.Trades)
		}
		previous = event.Book
	}
}

func assertEventWithinSimulatorBounds(t *testing.T, event sim.Event) {
	t.Helper()

	assertBoundedBookInvariant(t, event.Book)
	for _, change := range event.BookChanges {
		if change.PriceTicks < 10000 || change.PriceTicks > 10000000 {
			t.Fatalf("book change seq %d price = %d, want within 10000..10000000", change.Seq, change.PriceTicks)
		}
		if change.QuantityLots < 0 {
			t.Fatalf("book change seq %d has negative quantity %d", change.Seq, change.QuantityLots)
		}
	}
	for _, trade := range event.Trades {
		if trade.PriceTicks < 10000 || trade.PriceTicks > 10000000 {
			t.Fatalf("trade %d price = %d, want within 10000..10000000", trade.ID, trade.PriceTicks)
		}
		if trade.QuantityLots <= 0 {
			t.Fatalf("trade %d quantity = %d, want positive", trade.ID, trade.QuantityLots)
		}
	}
}

func assertBoundedBookInvariant(t *testing.T, snap model.BookSnapshot) {
	t.Helper()

	if len(snap.Bids) < 20 || len(snap.Bids) > 50 {
		t.Fatalf("snapshot has %d bids, want 20..50", len(snap.Bids))
	}
	if len(snap.Asks) < 20 || len(snap.Asks) > 50 {
		t.Fatalf("snapshot has %d asks, want 20..50", len(snap.Asks))
	}
	assertBookInvariant(t, snap)
	for i, level := range snap.Bids {
		if level.PriceTicks < 10000 || level.PriceTicks > 10000000 {
			t.Fatalf("bid %d price = %d, want within 10000..10000000", i, level.PriceTicks)
		}
	}
	for i, level := range snap.Asks {
		if level.PriceTicks < 10000 || level.PriceTicks > 10000000 {
			t.Fatalf("ask %d price = %d, want within 10000..10000000", i, level.PriceTicks)
		}
	}
}

func testConfig(seed int64, epochMS int64) sim.Config {
	return sim.Config{
		Seed:     seed,
		EpochMS:  epochMS,
		MidTicks: 6400000,
		StepMS:   100,
	}
}

func normalizeEventTime(event sim.Event, deltaMS int64) sim.Event {
	event.TimeMS -= deltaMS
	for index := range event.Trades {
		event.Trades[index].TimeMS -= deltaMS
	}
	return event
}

func assertTradesConsumeAvailableLiquidity(t *testing.T, previous model.BookSnapshot, trades []model.Trade) {
	t.Helper()
	book := cloneTestBook(previous)
	for _, trade := range trades {
		if trade.QuantityLots <= 0 {
			t.Fatalf("trade %d has non-positive quantity %d", trade.ID, trade.QuantityLots)
		}
		opposite := book.Asks[0]
		if trade.Side == "sell" {
			opposite = book.Bids[0]
		}
		if trade.PriceTicks != opposite.PriceTicks {
			t.Fatalf("trade %d price = %d, want then-best opposite price %d for side %s", trade.ID, trade.PriceTicks, opposite.PriceTicks, trade.Side)
		}
		if trade.QuantityLots > opposite.QuantityLots {
			t.Fatalf("trade %d quantity = %d, want at most then-available opposite size %d", trade.ID, trade.QuantityLots, opposite.QuantityLots)
		}
		consumeBookLevel(t, &book, trade)
	}
}

func cloneTestBook(book model.BookSnapshot) model.BookSnapshot {
	return model.BookSnapshot{Seq: book.Seq, Bids: append([]model.Level(nil), book.Bids...), Asks: append([]model.Level(nil), book.Asks...)}
}

func consumeBookLevel(t *testing.T, book *model.BookSnapshot, trade model.Trade) {
	t.Helper()
	levels := &book.Asks
	if trade.Side == "sell" {
		levels = &book.Bids
	}
	if len(*levels) == 0 {
		t.Fatalf("trade %d consumed empty opposite side", trade.ID)
	}
	if (*levels)[0].QuantityLots == trade.QuantityLots {
		*levels = (*levels)[1:]
		return
	}
	(*levels)[0].QuantityLots -= trade.QuantityLots
}

func assertBookInvariant(t *testing.T, snap model.BookSnapshot) {
	t.Helper()

	if len(snap.Bids) < 10 || len(snap.Asks) < 10 {
		t.Fatalf("snapshot depth bids=%d asks=%d, want at least 10 each", len(snap.Bids), len(snap.Asks))
	}
	if snap.Bids[0].PriceTicks >= snap.Asks[0].PriceTicks {
		t.Fatalf("book crossed: bid %d ask %d", snap.Bids[0].PriceTicks, snap.Asks[0].PriceTicks)
	}
	for i, level := range snap.Bids {
		if level.QuantityLots <= 0 {
			t.Fatalf("bid %d has quantity %d", i, level.QuantityLots)
		}
		if i > 0 && snap.Bids[i-1].PriceTicks <= level.PriceTicks {
			t.Fatalf("bids not descending at %d", i)
		}
	}
	for i, level := range snap.Asks {
		if level.QuantityLots <= 0 {
			t.Fatalf("ask %d has quantity %d", i, level.QuantityLots)
		}
		if i > 0 && snap.Asks[i-1].PriceTicks >= level.PriceTicks {
			t.Fatalf("asks not ascending at %d", i)
		}
	}
}
