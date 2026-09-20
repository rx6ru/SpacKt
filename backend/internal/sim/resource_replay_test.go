package sim_test

import (
	"testing"

	"spackt/internal/model"
	"spackt/internal/sim"
)

func TestLongReplayResourceContractsFor360And1440Minutes(t *testing.T) {
	tests := []struct {
		name    string
		seed    int64
		minutes int
		mid     int64
	}{
		{name: "360 minutes default", seed: 7, minutes: 360, mid: 6_400_000},
		{name: "1440 minutes negative seed", seed: -41, minutes: 1440, mid: 6_400_000},
		{name: "360 minutes near minimum", seed: 53, minutes: 360, mid: 10_000},
		{name: "360 minutes near maximum", seed: 59, minutes: 360, mid: 10_000_000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := sim.New(sim.Config{Seed: tt.seed, EpochMS: 1_700_000_000_000, MidTicks: tt.mid, StepMS: 100})
			previous := model.BookSnapshot{}
			var lastTradeID uint64
			steps := tt.minutes * 60 * 10

			for step := 0; step < steps; step++ {
				event := s.Next()
				if event.Rev != uint64(step+1) {
					t.Fatalf("step %d rev = %d, want %d", step, event.Rev, step+1)
				}
				if event.TimeMS != 1_700_000_000_000+int64(step*100) {
					t.Fatalf("step %d time = %d", step, event.TimeMS)
				}
				assertBoundedBookInvariant(t, event.Book)
				assertEventChangesReplay(t, previous, event)
				assertEventFillResourceBounds(t, event, &lastTradeID)
				previous = event.Book
			}
		})
	}
}

func TestEventReturnedSlicesDoNotAliasSimulatorState(t *testing.T) {
	s := sim.New(testConfig(17, 1_700_000_000_000))
	var event sim.Event
	for step := 0; step < 5_000; step++ {
		event = s.Next()
		if len(event.Trades) > 0 && len(event.BookChanges) > 0 && len(event.Book.Bids) > 0 {
			break
		}
	}
	if len(event.Book.Bids) == 0 || len(event.BookChanges) == 0 || len(event.Trades) == 0 {
		t.Fatalf("did not find event with book, changes, and trades")
	}

	event.Book.Bids[0].PriceTicks = -1
	event.BookChanges[0].PriceTicks = -1
	event.Trades[0].PriceTicks = -1

	next := s.Next()
	assertBoundedBookInvariant(t, next.Book)
	for _, change := range next.BookChanges {
		if change.PriceTicks == -1 {
			t.Fatalf("mutating returned book changes poisoned simulator state: %+v", next.BookChanges)
		}
	}
	for _, trade := range next.Trades {
		if trade.PriceTicks == -1 {
			t.Fatalf("mutating returned trades poisoned simulator state: %+v", next.Trades)
		}
	}
}

func assertEventChangesReplay(t *testing.T, previous model.BookSnapshot, event sim.Event) {
	t.Helper()
	if len(event.BookChanges) == 0 {
		if !sameBook(previous, event.Book) {
			t.Fatalf("event without book changes changed book: previous=%+v event=%+v", previous, event.Book)
		}
		return
	}
	replayed := replayBookLevelUpdates(t, previous, event.BookChanges)
	if !sameBook(replayed, event.Book) {
		t.Fatalf("event changes do not replay to book\nreplayed=%+v\nwant=%+v", replayed, event.Book)
	}
}

func assertEventFillResourceBounds(t *testing.T, event sim.Event, lastTradeID *uint64) {
	t.Helper()
	if len(event.Trades) > 1_024 {
		t.Fatalf("step has %d fills, want at most 1024", len(event.Trades))
	}
	var totalLots int64
	for _, trade := range event.Trades {
		if trade.ID != *lastTradeID+1 {
			t.Fatalf("trade ID = %d, want %d", trade.ID, *lastTradeID+1)
		}
		*lastTradeID = trade.ID
		if trade.TimeMS != event.TimeMS {
			t.Fatalf("trade %d time = %d, want event time %d", trade.ID, trade.TimeMS, event.TimeMS)
		}
		if trade.PriceTicks < 10_000 || trade.PriceTicks > 10_000_000 {
			t.Fatalf("trade %d price = %d, want within bounds", trade.ID, trade.PriceTicks)
		}
		if trade.QuantityLots <= 0 || trade.QuantityLots > 10_000 {
			t.Fatalf("trade %d quantity = %d, want 1..10000", trade.ID, trade.QuantityLots)
		}
		totalLots += trade.QuantityLots
		if totalLots > 10_000 {
			t.Fatalf("event fill quantity total = %d, want at most 10000", totalLots)
		}
	}
}
