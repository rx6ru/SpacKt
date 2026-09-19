package book_test

import (
	"testing"

	"spackt/internal/book"
	"spackt/internal/model"
)

func TestNewStartsWithPositiveSortedDepthAndNoCross(t *testing.T) {
	b := book.New(10000)
	snap := b.Snapshot()

	assertPublicBookInvariant(t, snap)
}

func TestApplyRemovesZeroSizeLevel(t *testing.T) {
	b := book.New(10000)
	before := b.Snapshot()
	requireBookDepth(t, before)
	price := before.Bids[0].PriceTicks

	if err := b.Apply(book.LevelUpdate{Side: book.SideBid, PriceTicks: price, QuantityLots: 0}); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}

	after := b.Snapshot()
	if after.Seq != before.Seq+1 {
		t.Fatalf("snapshot seq = %d, want %d after zero-size update", after.Seq, before.Seq+1)
	}
	for _, level := range after.Bids {
		if level.PriceTicks == price {
			t.Fatalf("bid level at %d remained after zero-size update", price)
		}
	}
}

func TestApplyRejectsProvidedSequenceNumber(t *testing.T) {
	b := book.New(10000)
	snap := b.Snapshot()
	requireBookDepth(t, snap)

	err := b.Apply(book.LevelUpdate{Seq: snap.Seq + 1, Side: book.SideBid, PriceTicks: snap.Bids[0].PriceTicks, QuantityLots: snap.Bids[0].QuantityLots + 1})
	if err == nil {
		t.Fatal("Apply accepted a caller-provided sequence number")
	}
}

func TestApplyTradeConsumesAvailableAskForBuy(t *testing.T) {
	b := book.New(10000)
	before := b.Snapshot()
	requireBookDepth(t, before)
	bestAsk := before.Asks[0]
	fillLots := bestAsk.QuantityLots

	changes, err := b.ApplyTrade(model.Trade{ID: 1, TimeMS: 1700000000000, PriceTicks: bestAsk.PriceTicks, QuantityLots: fillLots, Side: "buy"})
	if err != nil {
		t.Fatalf("ApplyTrade returned error: %v", err)
	}

	after := b.Snapshot()
	assertContiguousGeneratedSequences(t, changes, before.Seq+1, after.Seq)
	assertChangesAgreeWithSnapshot(t, changes, after)
	if len(after.Asks) == 0 {
		t.Fatal("book has no asks after buy trade")
	}
	if after.Asks[0].PriceTicks == bestAsk.PriceTicks {
		t.Fatalf("best ask at %d was not consumed", bestAsk.PriceTicks)
	}
	assertPublicBookInvariant(t, after)
}

func TestApplyTradeReplenishesPublicDepthAfterConsumption(t *testing.T) {
	b := book.New(10000)
	for i := 0; i < 30; i++ {
		snap := b.Snapshot()
		requireBookDepth(t, snap)
		bestAsk := snap.Asks[0]
		changes, err := b.ApplyTrade(model.Trade{
			ID:           uint64(i + 1),
			TimeMS:       1700000000000 + int64(i*100),
			PriceTicks:   bestAsk.PriceTicks,
			QuantityLots: bestAsk.QuantityLots,
			Side:         "buy",
		})
		if err != nil {
			t.Fatalf("ApplyTrade %d returned error: %v", i, err)
		}
		after := b.Snapshot()
		assertContiguousGeneratedSequences(t, changes, snap.Seq+1, after.Seq)
		assertChangesAgreeWithSnapshot(t, changes, after)
	}

	assertPublicBookInvariant(t, b.Snapshot())
}

func TestApplyTradeReplenishesDepthWhenBestBidIsDepletedNearMinimumPrice(t *testing.T) {
	b := book.New(1)
	before := b.Snapshot()
	requireBookDepth(t, before)
	bestBid := before.Bids[0]

	changes, err := b.ApplyTrade(model.Trade{
		ID:           1,
		TimeMS:       1700000000000,
		PriceTicks:   bestBid.PriceTicks,
		QuantityLots: bestBid.QuantityLots,
		Side:         "sell",
	})
	if err != nil {
		t.Fatalf("ApplyTrade returned error: %v", err)
	}

	after := b.Snapshot()
	assertContiguousGeneratedSequences(t, changes, before.Seq+1, after.Seq)
	assertChangesAgreeWithSnapshot(t, changes, after)
	assertPublicBookInvariant(t, after)
	assertBookDepthWithinPublicBounds(t, after)
	assertBookPricesPositive(t, after)
}

func TestSnapshotSequenceMatchesAppliedMutations(t *testing.T) {
	b := book.New(10000)
	start := b.Snapshot()
	requireBookDepth(t, start)

	if err := b.Apply(book.LevelUpdate{Side: book.SideBid, PriceTicks: start.Bids[0].PriceTicks, QuantityLots: start.Bids[0].QuantityLots + 1}); err != nil {
		t.Fatalf("first Apply returned error: %v", err)
	}
	if err := b.Apply(book.LevelUpdate{Side: book.SideAsk, PriceTicks: start.Asks[0].PriceTicks, QuantityLots: start.Asks[0].QuantityLots + 1}); err != nil {
		t.Fatalf("second Apply returned error: %v", err)
	}

	got := b.Snapshot().Seq
	want := start.Seq + 2
	if got != want {
		t.Fatalf("snapshot seq = %d, want %d after two level mutations", got, want)
	}
}

func TestSnapshotReturnsOwnedCopies(t *testing.T) {
	b := book.New(10000)
	snap := b.Snapshot()
	requireBookDepth(t, snap)
	original := snap.Bids[0]
	snap.Bids[0].QuantityLots = 0

	fresh := b.Snapshot()
	if fresh.Bids[0] != original {
		t.Fatalf("mutating snapshot changed book state: got %+v, want %+v", fresh.Bids[0], original)
	}
}

func requireBookDepth(t *testing.T, snap model.BookSnapshot) {
	t.Helper()

	if len(snap.Bids) == 0 || len(snap.Asks) == 0 {
		t.Fatalf("snapshot depth bids=%d asks=%d, need at least one level per side for this test", len(snap.Bids), len(snap.Asks))
	}
}

func assertContiguousGeneratedSequences(t *testing.T, changes []book.LevelUpdate, first uint64, last uint64) {
	t.Helper()

	if first > last {
		if len(changes) != 0 {
			t.Fatalf("got %d changes for empty sequence range %d..%d", len(changes), first, last)
		}
		return
	}
	if uint64(len(changes)) != last-first+1 {
		t.Fatalf("change count = %d, want %d for sequence range %d..%d", len(changes), last-first+1, first, last)
	}
	for i, change := range changes {
		want := first + uint64(i)
		if change.Seq != want {
			t.Fatalf("change %d seq = %d, want %d", i, change.Seq, want)
		}
	}
}

func assertChangesAgreeWithSnapshot(t *testing.T, changes []book.LevelUpdate, snap model.BookSnapshot) {
	t.Helper()

	for _, change := range changes {
		levels := snap.Bids
		if change.Side == book.SideAsk {
			levels = snap.Asks
		}
		found := false
		for _, level := range levels {
			if level.PriceTicks != change.PriceTicks {
				continue
			}
			found = true
			if level.QuantityLots != change.QuantityLots {
				t.Fatalf("snapshot quantity at %d %s = %d, want %d from change seq %d", change.PriceTicks, change.Side, level.QuantityLots, change.QuantityLots, change.Seq)
			}
		}
		if change.QuantityLots == 0 && found {
			t.Fatalf("zero-size change seq %d for %s %d remains in snapshot", change.Seq, change.Side, change.PriceTicks)
		}
		if change.QuantityLots > 0 && !found {
			t.Fatalf("positive change seq %d for %s %d missing from snapshot", change.Seq, change.Side, change.PriceTicks)
		}
	}
}

func assertBookPricesPositive(t *testing.T, snap model.BookSnapshot) {
	t.Helper()

	for i, level := range snap.Bids {
		if level.PriceTicks <= 0 {
			t.Fatalf("bid %d has non-positive price %d", i, level.PriceTicks)
		}
	}
	for i, level := range snap.Asks {
		if level.PriceTicks <= 0 {
			t.Fatalf("ask %d has non-positive price %d", i, level.PriceTicks)
		}
	}
}

func assertBookDepthWithinPublicBounds(t *testing.T, snap model.BookSnapshot) {
	t.Helper()

	if len(snap.Bids) < 20 || len(snap.Bids) > 50 {
		t.Fatalf("snapshot has %d bids, want 20..50", len(snap.Bids))
	}
	if len(snap.Asks) < 20 || len(snap.Asks) > 50 {
		t.Fatalf("snapshot has %d asks, want 20..50", len(snap.Asks))
	}
}

func assertPublicBookInvariant(t *testing.T, snap model.BookSnapshot) {
	t.Helper()

	if len(snap.Bids) < 10 {
		t.Fatalf("snapshot has %d bids, want at least 10", len(snap.Bids))
	}
	if len(snap.Asks) < 10 {
		t.Fatalf("snapshot has %d asks, want at least 10", len(snap.Asks))
	}
	if snap.Bids[0].PriceTicks >= snap.Asks[0].PriceTicks {
		t.Fatalf("book is crossed: best bid %d, best ask %d", snap.Bids[0].PriceTicks, snap.Asks[0].PriceTicks)
	}
	for i, level := range snap.Bids {
		if level.QuantityLots <= 0 {
			t.Fatalf("bid %d has non-positive quantity %d", i, level.QuantityLots)
		}
		if i > 0 && snap.Bids[i-1].PriceTicks <= level.PriceTicks {
			t.Fatalf("bids not descending at %d: %d then %d", i, snap.Bids[i-1].PriceTicks, level.PriceTicks)
		}
	}
	for i, level := range snap.Asks {
		if level.QuantityLots <= 0 {
			t.Fatalf("ask %d has non-positive quantity %d", i, level.QuantityLots)
		}
		if i > 0 && snap.Asks[i-1].PriceTicks >= level.PriceTicks {
			t.Fatalf("asks not ascending at %d: %d then %d", i, snap.Asks[i-1].PriceTicks, level.PriceTicks)
		}
	}
}
