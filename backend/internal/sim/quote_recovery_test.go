package sim_test

import (
	"testing"

	"spackt/internal/book"
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
		if event.Trade != nil || len(event.BookChanges) == 0 {
			previous = event.Book
			continue
		}
		first := event.BookChanges[0]
		bidImproved := first.Side == "bid" &&
			first.QuantityLots > 0 &&
			first.PriceTicks > previous.Bids[0].PriceTicks &&
			first.PriceTicks < previous.Asks[0].PriceTicks
		askImproved := first.Side == "ask" &&
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

func TestWideGapRecoveryUsesPreviousMidpointAnchor(t *testing.T) {
	s := sim.New(testConfig(7, 1700000000000))
	previous := s.Next().Book

	for step := 1; step < 10000; step++ {
		event := s.Next()
		replayed := cloneBook(previous)
		previousMid := (previous.Bids[0].PriceTicks + previous.Asks[0].PriceTicks) / 2
		sawWideGap := false
		sawRecoveryBid := false
		sawRecoveryAsk := false

		for _, change := range event.BookChanges {
			applyPublicBookChange(t, &replayed, change)
			spread := bestSpreadTicks(replayed)
			if spread > maxPublicSpreadTicks {
				sawWideGap = true
			}
			if sawWideGap && change.Side == "bid" && change.QuantityLots > 0 && change.PriceTicks == previousMid-10 {
				sawRecoveryBid = true
			}
			if sawWideGap && change.Side == "ask" && change.QuantityLots > 0 && change.PriceTicks == previousMid+10 {
				sawRecoveryAsk = true
			}
			if sawWideGap && sawRecoveryBid && sawRecoveryAsk {
				if finalSpread := bestSpreadTicks(event.Book); finalSpread <= 0 || finalSpread > maxPublicSpreadTicks {
					t.Fatalf("step %d final spread = %d ticks, want 1..20 after anchored recovery", step, finalSpread)
				}
				return
			}
		}

		previous = event.Book
	}

	t.Fatal("no event exposed a wide intermediate gap followed by positive recovery quotes at previous midpoint +/- 10 ticks in 10000 steps")
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

func TestTradeExecutesAgainstPreviousBestOppositeQuote(t *testing.T) {
	s := sim.New(testConfig(7, 1700000000000))
	previous := s.Next().Book
	checked := 0

	for step := 1; step < 10000 && checked < 200; step++ {
		event := s.Next()
		if event.Trade == nil {
			previous = event.Book
			continue
		}
		opposite := previous.Asks[0]
		if event.Trade.Side == "sell" {
			opposite = previous.Bids[0]
		}
		if event.Trade.PriceTicks != opposite.PriceTicks {
			t.Fatalf("trade %d price = %d, want previous best opposite price %d", event.Trade.ID, event.Trade.PriceTicks, opposite.PriceTicks)
		}
		if event.Trade.QuantityLots <= 0 {
			t.Fatalf("trade %d quantity = %d, want positive", event.Trade.ID, event.Trade.QuantityLots)
		}
		if event.Trade.QuantityLots > opposite.QuantityLots {
			t.Fatalf("trade %d quantity = %d, want at most previous best opposite size %d", event.Trade.ID, event.Trade.QuantityLots, opposite.QuantityLots)
		}
		previous = event.Book
		checked++
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

func applyPublicBookChange(t *testing.T, book *model.BookSnapshot, update book.LevelUpdate) {
	t.Helper()
	book.Seq = update.Seq
	switch update.Side {
	case "bid":
		book.Bids = applyLevelUpdate(book.Bids, update.PriceTicks, update.QuantityLots, true)
	case "ask":
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
