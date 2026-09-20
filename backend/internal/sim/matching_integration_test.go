package sim_test

import (
	"reflect"
	"testing"

	"spackt/internal/model"
	"spackt/internal/sim"
)

func TestEventTradesListIDsAreContinuousAcrossAllEvents(t *testing.T) {
	simulator := sim.New(testConfig(7, 1_700_000_000_000))

	var lastSeen uint64
	seenTrade := false
	for i := 0; i < 5_000; i++ {
		event := simulator.Next()
		if len(event.Trades) == 0 {
			continue
		}
		seenTrade = true
		assertOrderedEventTrades(t, event)
		if event.Trades[0].ID != lastSeen+1 {
			t.Fatalf("event %d first trade ID = %d, want %d after previous event", i, event.Trades[0].ID, lastSeen+1)
		}
		lastSeen = event.Trades[len(event.Trades)-1].ID
	}
	if !seenTrade {
		t.Fatalf("no trade event found in deterministic scan")
	}
}

func TestSimulatorEventuallyEmitsOrderedManyFillEvent(t *testing.T) {
	simulator := sim.New(testConfig(7, 1_700_000_000_000))

	for i := 0; i < 5_000; i++ {
		event := simulator.Next()
		if len(event.Trades) < 2 {
			continue
		}
		assertOrderedEventTrades(t, event)
		if distinctTradePrices(event.Trades) < 2 {
			t.Fatalf("multi-fill event prices = %+v, want seeded sweep across multiple price levels", event.Trades)
		}
		if event.Book.Seq != event.BookChanges[len(event.BookChanges)-1].Seq {
			t.Fatalf("event book seq = %d, want last change seq %d", event.Book.Seq, event.BookChanges[len(event.BookChanges)-1].Seq)
		}
		return
	}
	t.Fatalf("no multi-fill event found; matching integration should produce at least one seeded sweep")
}

func TestFirstEventBookChangesReplayFromSequenceZero(t *testing.T) {
	simulator := sim.New(testConfig(7, 1_700_000_000_000))

	event := simulator.Next()

	if event.Rev != 1 {
		t.Fatalf("first event rev = %d, want 1", event.Rev)
	}
	if event.TimeMS != 1_700_000_000_000 {
		t.Fatalf("first event time = %d, want epoch", event.TimeMS)
	}
	replayed := replayBookLevelUpdates(t, model.BookSnapshot{}, event.BookChanges)
	if !sameBook(replayed, event.Book) {
		t.Fatalf("first event book changes do not replay from empty book\nreplayed=%+v\nwant=%+v", replayed, event.Book)
	}
	if len(event.Trades) > 0 && event.Trades[0].ID != 1 {
		t.Fatalf("first event first trade ID = %d, want 1", event.Trades[0].ID)
	}
}

func TestQuoteOrCancelStepsDoNotConsumeTradeIDs(t *testing.T) {
	simulator := sim.New(testConfig(3, 1_700_000_000_000))
	var lastSeen uint64
	sawEmptyStep := false
	var previous sim.Event

	for i := 0; i < 5_000; i++ {
		event := simulator.Next()
		if len(event.Trades) == 0 {
			if i > 0 {
				if event.Rev != previous.Rev+1 {
					t.Fatalf("empty quote/cancel rev = %d, want %d", event.Rev, previous.Rev+1)
				}
				if event.TimeMS != previous.TimeMS+100 {
					t.Fatalf("empty quote/cancel time delta = %d, want 100", event.TimeMS-previous.TimeMS)
				}
			}
			sawEmptyStep = true
			previous = event
			continue
		}

		assertOrderedEventTrades(t, event)
		if sawEmptyStep {
			if event.Trades[0].ID != lastSeen+1 {
				t.Fatalf("first trade ID after empty quote/cancel step = %d, want %d", event.Trades[0].ID, lastSeen+1)
			}
			return
		}
		lastSeen = event.Trades[len(event.Trades)-1].ID
		previous = event
	}
	t.Fatalf("no empty quote/cancel step followed by a trade found in deterministic scan")
}

func assertOrderedEventTrades(t *testing.T, event sim.Event) {
	t.Helper()
	if len(event.Trades) > 1_024 {
		t.Fatalf("event has %d fills, want at most 1024", len(event.Trades))
	}
	var totalLots int64
	for index, trade := range event.Trades {
		if trade.ID == 0 {
			t.Fatalf("trade %d has zero ID: %+v", index, trade)
		}
		if trade.TimeMS != event.TimeMS {
			t.Fatalf("trade %d time = %d, want event time %d", index, trade.TimeMS, event.TimeMS)
		}
		if trade.PriceTicks < 10_000 || trade.PriceTicks > 10_000_000 {
			t.Fatalf("trade %d price = %d, want within simulator bounds", index, trade.PriceTicks)
		}
		if trade.QuantityLots <= 0 || trade.QuantityLots > 10_000 {
			t.Fatalf("trade %d quantity = %d, want positive customer lot bound", index, trade.QuantityLots)
		}
		totalLots += trade.QuantityLots
		if totalLots > 10_000 {
			t.Fatalf("event total fill quantity = %d, want at most 10000 customer lots", totalLots)
		}
		if trade.Side != "buy" && trade.Side != "sell" {
			t.Fatalf("trade %d side = %q, want buy or sell", index, trade.Side)
		}
		if index == 0 {
			continue
		}
		previous := event.Trades[index-1]
		if trade.ID != previous.ID+1 {
			t.Fatalf("trade %d ID = %d, want %d", index, trade.ID, previous.ID+1)
		}
		if trade.Side != previous.Side {
			t.Fatalf("trade %d side = %q, want same aggressor side %q", index, trade.Side, previous.Side)
		}
		if trade.Side == "buy" && trade.PriceTicks < previous.PriceTicks {
			t.Fatalf("buy trade %d price = %d after %d, want nondecreasing best-price order", index, trade.PriceTicks, previous.PriceTicks)
		}
		if trade.Side == "sell" && trade.PriceTicks > previous.PriceTicks {
			t.Fatalf("sell trade %d price = %d after %d, want nonincreasing best-price order", index, trade.PriceTicks, previous.PriceTicks)
		}
	}
}

func distinctTradePrices(trades []model.Trade) int {
	seen := make(map[int64]struct{}, len(trades))
	for _, trade := range trades {
		seen[trade.PriceTicks] = struct{}{}
	}
	return len(seen)
}

func replayBookLevelUpdates(t *testing.T, snapshot model.BookSnapshot, changes any) model.BookSnapshot {
	t.Helper()
	book := model.BookSnapshot{
		Seq:  snapshot.Seq,
		Bids: append([]model.Level(nil), snapshot.Bids...),
		Asks: append([]model.Level(nil), snapshot.Asks...),
	}
	for _, raw := range modelLevelChanges(t, changes) {
		change := raw
		if change.Seq != book.Seq+1 {
			t.Fatalf("change seq = %d after %d", change.Seq, book.Seq)
		}
		book.Seq = change.Seq
		switch change.Side {
		case "bid":
			book.Bids = applyPublicLevel(book.Bids, change.PriceTicks, change.QuantityLots, true)
		case "ask":
			book.Asks = applyPublicLevel(book.Asks, change.PriceTicks, change.QuantityLots, false)
		default:
			t.Fatalf("change side = %q", change.Side)
		}
	}
	return book
}

func modelLevelChanges(t *testing.T, changes any) []model.LevelChange {
	t.Helper()
	value := reflect.ValueOf(changes)
	if value.Kind() != reflect.Slice {
		t.Fatalf("book changes have kind %s, want slice", value.Kind())
	}
	out := make([]model.LevelChange, 0, value.Len())
	for i := 0; i < value.Len(); i++ {
		item := value.Index(i)
		out = append(out, model.LevelChange{
			Seq:          item.FieldByName("Seq").Uint(),
			Side:         model.BookSide(item.FieldByName("Side").String()),
			PriceTicks:   item.FieldByName("PriceTicks").Int(),
			QuantityLots: item.FieldByName("QuantityLots").Int(),
		})
	}
	return out
}

func applyPublicLevel(levels []model.Level, priceTicks int64, quantityLots int64, descending bool) []model.Level {
	out := append([]model.Level(nil), levels...)
	for index, level := range out {
		if level.PriceTicks == priceTicks {
			if quantityLots == 0 {
				return append(out[:index], out[index+1:]...)
			}
			out[index].QuantityLots = quantityLots
			return out
		}
	}
	if quantityLots == 0 {
		return out
	}
	out = append(out, model.Level{PriceTicks: priceTicks, QuantityLots: quantityLots})
	for i := len(out) - 1; i > 0; i-- {
		before := out[i-1].PriceTicks
		after := out[i].PriceTicks
		if (descending && before > after) || (!descending && before < after) {
			break
		}
		out[i-1], out[i] = out[i], out[i-1]
	}
	return out
}

func sameBook(left model.BookSnapshot, right model.BookSnapshot) bool {
	if left.Seq != right.Seq || len(left.Bids) != len(right.Bids) || len(left.Asks) != len(right.Asks) {
		return false
	}
	for i := range left.Bids {
		if left.Bids[i] != right.Bids[i] {
			return false
		}
	}
	for i := range left.Asks {
		if left.Asks[i] != right.Asks[i] {
			return false
		}
	}
	return true
}
