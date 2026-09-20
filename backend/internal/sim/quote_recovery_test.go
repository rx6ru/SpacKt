package sim_test

import (
	"testing"

	"spackt/internal/model"
	"spackt/internal/sim"
)

const maxPublicSpreadTicks = int64(20)

func TestPublicSpreadStaysWithinTwentyTicksForSixHours(t *testing.T) {
	s := sim.New(testConfig(7, 1700000000000))

	for step := 0; step < 216000; step++ {
		event := s.Next()
		spread := bestSpreadTicks(event.Book)
		if spread <= 0 || spread > maxPublicSpreadTicks {
			t.Fatalf("step %d spread = %d ticks, want 1..20", step, spread)
		}
	}
}

func TestPublicSpreadStaysWithinTwentyTicksForFixedSeeds(t *testing.T) {
	tests := []struct {
		name string
		seed int64
	}{
		{name: "seed 3", seed: 3},
		{name: "seed 17", seed: 17},
		{name: "seed 41", seed: 41},
		{name: "negative seed", seed: -41},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := sim.New(testConfig(tt.seed, 1700000000000))
			for step := 0; step < 10000; step++ {
				event := s.Next()
				spread := bestSpreadTicks(event.Book)
				if spread <= 0 || spread > maxPublicSpreadTicks {
					t.Fatalf("step %d spread = %d ticks, want 1..20", step, spread)
				}
			}
		})
	}
}

func TestConfiguredMidpointBoundaryBooksStayBoundedAndCapped(t *testing.T) {
	tests := []struct {
		name     string
		seed     int64
		midTicks int64
	}{
		{name: "near minimum", seed: 53, midTicks: 10000},
		{name: "near maximum", seed: 59, midTicks: 10000000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := sim.New(sim.Config{
				Seed:     tt.seed,
				EpochMS:  1700000000000,
				MidTicks: tt.midTicks,
				StepMS:   100,
			})

			for step := 0; step < 1000; step++ {
				event := s.Next()
				assertBoundedBookInvariant(t, event.Book)
				spread := bestSpreadTicks(event.Book)
				if spread <= 0 || spread > maxPublicSpreadTicks {
					t.Fatalf("step %d spread = %d ticks, want 1..20", step, spread)
				}
			}
		})
	}
}

func TestFirstNonTradeChangeCanImproveInsidePreviousBest(t *testing.T) {
	s := sim.New(testConfig(7, 1700000000000))
	previous := s.Next().Book

	for step := 1; step < 10000; step++ {
		event := s.Next()
		if len(event.Trades) != 0 || len(event.BookChanges) == 0 {
			previous = event.Book
			continue
		}
		first := modelLevelChanges(t, event.BookChanges)[0]
		bidImproved := first.Side == model.BookSideBid &&
			first.QuantityLots > 0 &&
			first.PriceTicks > previous.Bids[0].PriceTicks &&
			first.PriceTicks < previous.Asks[0].PriceTicks
		askImproved := first.Side == model.BookSideAsk &&
			first.QuantityLots > 0 &&
			first.PriceTicks < previous.Asks[0].PriceTicks &&
			first.PriceTicks > previous.Bids[0].PriceTicks
		if bidImproved || askImproved {
			return
		}
		previous = event.Book
	}

	t.Fatal("no non-trade event used its first book change to add a positive quote inside the previous best quotes in 10000 steps")
}

func TestBookChangesUseContiguousSequencesAndMatchPublishedBook(t *testing.T) {
	s := sim.New(testConfig(7, 1700000000000))
	var previousSeq uint64

	for step := 0; step < 10000; step++ {
		event := s.Next()
		if len(event.BookChanges) == 0 {
			if event.Book.Seq != previousSeq {
				t.Fatalf("step %d book seq = %d, want unchanged %d without changes", step, event.Book.Seq, previousSeq)
			}
			continue
		}
		for i, change := range event.BookChanges {
			want := previousSeq + uint64(i) + 1
			if change.Seq != want {
				t.Fatalf("step %d change %d seq = %d, want %d", step, i, change.Seq, want)
			}
		}
		lastSeq := event.BookChanges[len(event.BookChanges)-1].Seq
		if event.Book.Seq != lastSeq {
			t.Fatalf("step %d book seq = %d, want last change seq %d", step, event.Book.Seq, lastSeq)
		}
		previousSeq = lastSeq
	}
}

func TestTradesExecuteAgainstThenBestOppositeQuote(t *testing.T) {
	s := sim.New(testConfig(7, 1700000000000))
	previous := s.Next().Book
	checked := 0

	for step := 1; step < 10000 && checked < 200; step++ {
		event := s.Next()
		if len(event.Trades) == 0 {
			previous = event.Book
			continue
		}
		assertTradesConsumeAvailableLiquidity(t, previous, event.Trades)
		previous = event.Book
		checked += len(event.Trades)
	}
	if checked < 200 {
		t.Fatalf("checked %d trades in 10000 steps, want 200", checked)
	}
}

func bestSpreadTicks(book model.BookSnapshot) int64 {
	return book.Asks[0].PriceTicks - book.Bids[0].PriceTicks
}

func cloneBook(book model.BookSnapshot) model.BookSnapshot {
	return model.BookSnapshot{
		Seq:  book.Seq,
		Bids: append([]model.Level(nil), book.Bids...),
		Asks: append([]model.Level(nil), book.Asks...),
	}
}

func applyPublicBookChange(t *testing.T, book *model.BookSnapshot, update model.LevelChange) {
	t.Helper()
	book.Seq = update.Seq
	switch update.Side {
	case model.BookSideBid:
		book.Bids = applyLevelUpdate(book.Bids, update.PriceTicks, update.QuantityLots, true)
	case model.BookSideAsk:
		book.Asks = applyLevelUpdate(book.Asks, update.PriceTicks, update.QuantityLots, false)
	default:
		t.Fatalf("book change seq %d has side %q, want bid or ask", update.Seq, update.Side)
	}
	if len(book.Bids) == 0 || len(book.Asks) == 0 {
		t.Fatalf("book change seq %d left empty side", update.Seq)
	}
}

func applyLevelUpdate(levels []model.Level, priceTicks int64, quantityLots int64, descending bool) []model.Level {
	out := make([]model.Level, 0, len(levels)+1)
	inserted := false
	for _, level := range levels {
		if level.PriceTicks == priceTicks {
			if quantityLots > 0 {
				out = append(out, model.Level{PriceTicks: priceTicks, QuantityLots: quantityLots})
			}
			inserted = true
			continue
		}
		if !inserted && quantityLots > 0 {
			before := priceTicks > level.PriceTicks
			if !descending {
				before = priceTicks < level.PriceTicks
			}
			if before {
				out = append(out, model.Level{PriceTicks: priceTicks, QuantityLots: quantityLots})
				inserted = true
			}
		}
		out = append(out, level)
	}
	if !inserted && quantityLots > 0 {
		out = append(out, model.Level{PriceTicks: priceTicks, QuantityLots: quantityLots})
	}
	return out
}
