package sim

import (
	"errors"
	"testing"

	"spackt/internal/matching"
	"spackt/internal/model"
)

func TestMaintainLiquidityRestoresBoundaryBooks(t *testing.T) {
	tests := []struct {
		name   string
		anchor int64
		seed   func(t *testing.T, engine *matching.Engine)
	}{
		{
			name:   "empty",
			anchor: 6_400_000,
		},
		{
			name:   "shallow wide",
			anchor: 6_400_000,
			seed: func(t *testing.T, engine *matching.Engine) {
				mustSubmitResting(t, engine, matching.Buy, 6_399_950, 5)
				mustSubmitResting(t, engine, matching.Sell, 6_400_050, 5)
			},
		},
		{
			name:   "near minimum",
			anchor: 10_020,
			seed: func(t *testing.T, engine *matching.Engine) {
				mustSubmitResting(t, engine, matching.Buy, 10_000, 5)
				mustSubmitResting(t, engine, matching.Sell, 10_080, 5)
			},
		},
		{
			name:   "near maximum",
			anchor: 9_999_980,
			seed: func(t *testing.T, engine *matching.Engine) {
				mustSubmitResting(t, engine, matching.Buy, 9_999_930, 5)
				mustSubmitResting(t, engine, matching.Sell, 10_000_000, 5)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			engine := newMaintenanceTestEngine(t, 100_000, 100_000, 1_024)
			if tt.seed != nil {
				tt.seed(t, engine)
			}
			before := engine.Snapshot()

			changes, err := maintainLiquidity(engine, tt.anchor, 500)
			if err != nil {
				t.Fatalf("maintainLiquidity returned error: %v", err)
			}

			after := engine.Snapshot()
			assertMaintainedBook(t, after)
			assertReplayLevelChanges(t, before, changes, after)
			assertPassiveMaintenanceChanges(t, before, changes)
		})
	}
}

func TestMaintainLiquidityReservesCapacityByCancelingOldestDuplicateOrders(t *testing.T) {
	engine := newMaintenanceTestEngine(t, 100_000, 100_000, 1_024)
	seedTwentyByTwentyBook(t, engine)
	for i := 0; i < 984; i++ {
		mustSubmitResting(t, engine, matching.Buy, 6_399_990, 1)
	}
	beforeOrders := ordersByID(engine.Orders())

	changes, err := maintainLiquidity(engine, 6_400_000, 500)
	if err != nil {
		t.Fatalf("maintainLiquidity returned error: %v", err)
	}
	if len(changes) == 0 {
		t.Fatalf("maintainLiquidity returned no changes for a full duplicate-queue book")
	}
	afterOrders := ordersByID(engine.Orders())
	assertExactlyCanceledOrderIDs(t, beforeOrders, afterOrders, []uint64{1, 41})
	if len(afterOrders) > 1_024 {
		t.Fatalf("active orders = %d, want at most 1024", len(afterOrders))
	}
	assertMaintainedBook(t, engine.Snapshot())
}

func TestMaintainLiquidityDoesNotOverflowPopulatedFullLevels(t *testing.T) {
	engine := newMaintenanceTestEngine(t, 100_000, 100_000, 1_024)
	mustSubmitResting(t, engine, matching.Buy, 6_399_995, 100_000)
	mustSubmitResting(t, engine, matching.Sell, 6_400_005, 100_000)

	changes, err := maintainLiquidity(engine, 6_400_000, 500)
	if err != nil {
		t.Fatalf("maintainLiquidity returned error: %v", err)
	}
	assertLevelCaps(t, engine.Snapshot(), 100_000)
	assertReplayLevelChanges(t, model.BookSnapshot{Seq: 2,
		Bids: []model.Level{{PriceTicks: 6_399_995, QuantityLots: 100_000}},
		Asks: []model.Level{{PriceTicks: 6_400_005, QuantityLots: 100_000}},
	}, changes, engine.Snapshot())
}

func TestMaintainLiquidityBudgetErrorDoesNotMutateOrPublishInvalidChanges(t *testing.T) {
	for _, budget := range []int{0, 1} {
		t.Run("budget", func(t *testing.T) {
			engine := newMaintenanceTestEngine(t, 100_000, 100_000, 1_024)
			mustSubmitResting(t, engine, matching.Buy, 6_399_990, 5)
			mustSubmitResting(t, engine, matching.Sell, 6_400_010, 5)
			beforeSnapshot := engine.Snapshot()
			beforeOrders := engine.Orders()

			changes, err := maintainLiquidity(engine, 6_400_000, budget)
			if !errors.Is(err, errMaintenanceBudget) {
				t.Fatalf("maintainLiquidity error = %v, want errMaintenanceBudget", err)
			}
			if len(changes) != 0 {
				t.Fatalf("budget error returned changes %+v, want none", changes)
			}
			if !sameMaintenanceBook(beforeSnapshot, engine.Snapshot()) {
				t.Fatalf("budget error mutated snapshot: before=%+v after=%+v", beforeSnapshot, engine.Snapshot())
			}
			if !sameMaintenanceOrders(beforeOrders, engine.Orders()) {
				t.Fatalf("budget error mutated orders: before=%+v after=%+v", beforeOrders, engine.Orders())
			}
		})
	}
}

func TestMaintainLiquidityReplayAndRestingQuantityComeOnlyFromCancelsAndAdds(t *testing.T) {
	engine := newMaintenanceTestEngine(t, 100_000, 100_000, 1_024)
	seedTwentyByTwentyBook(t, engine)
	beforeSnapshot := engine.Snapshot()
	beforeOrders := ordersByID(engine.Orders())

	changes, err := maintainLiquidity(engine, 6_400_000, 500)
	if err != nil {
		t.Fatalf("maintainLiquidity returned error: %v", err)
	}
	afterSnapshot := engine.Snapshot()
	assertReplayLevelChanges(t, beforeSnapshot, changes, afterSnapshot)
	assertAllExistingOrdersUnchanged(t, beforeOrders, ordersByID(engine.Orders()))
	assertNoZeroQuantityUpdates(t, changes)
	if delta := totalRestingLots(afterSnapshot) - totalRestingLots(beforeSnapshot); delta != totalChangeDelta(beforeSnapshot, changes) {
		t.Fatalf("resting quantity delta = %d, want replayed add delta %d", delta, totalChangeDelta(beforeSnapshot, changes))
	}
}

func seedTwentyByTwentyBook(t *testing.T, engine *matching.Engine) {
	t.Helper()
	for i := 0; i < 20; i++ {
		quantity := seededMaintenanceQuantity(i + 1)
		mustSubmitResting(t, engine, matching.Buy, 6_399_990-int64(i), quantity)
		mustSubmitResting(t, engine, matching.Sell, 6_400_010+int64(i), quantity)
	}
}

func newMaintenanceTestEngine(t *testing.T, maxOrderLots int64, maxLevelLots int64, maxOrders int) *matching.Engine {
	t.Helper()
	engine, err := matching.New(matching.Limits{
		MinPriceTicks: 10_000,
		MaxPriceTicks: 10_000_000,
		MaxOrderLots:  maxOrderLots,
		MaxLevelLots:  maxLevelLots,
		MaxOrders:     maxOrders,
	})
	if err != nil {
		t.Fatalf("matching.New error: %v", err)
	}
	return engine
}

func mustSubmitResting(t *testing.T, engine *matching.Engine, side matching.Side, priceTicks int64, lots int64) matching.Result {
	t.Helper()
	result, err := engine.Submit(side, priceTicks, lots)
	if err != nil {
		t.Fatalf("Submit(%s, %d, %d) error: %v", side, priceTicks, lots, err)
	}
	if len(result.Fills) != 0 {
		t.Fatalf("Submit(%s, %d, %d) produced fills %+v; maintenance fixtures must rest passively", side, priceTicks, lots, result.Fills)
	}
	return result
}

func assertMaintainedBook(t *testing.T, snapshot model.BookSnapshot) {
	t.Helper()
	if len(snapshot.Bids) < 20 || len(snapshot.Bids) > 50 {
		t.Fatalf("bid depth = %d, want 20..50", len(snapshot.Bids))
	}
	if len(snapshot.Asks) < 20 || len(snapshot.Asks) > 50 {
		t.Fatalf("ask depth = %d, want 20..50", len(snapshot.Asks))
	}
	if len(snapshot.Bids) == 0 || len(snapshot.Asks) == 0 {
		t.Fatalf("snapshot has empty side: %+v", snapshot)
	}
	spread := snapshot.Asks[0].PriceTicks - snapshot.Bids[0].PriceTicks
	if spread < 1 || spread > 20 {
		t.Fatalf("spread = %d, want 1..20", spread)
	}
	assertLevelCaps(t, snapshot, 100_000)
	assertBookBoundsAndSort(t, snapshot)
}

func assertBookBoundsAndSort(t *testing.T, snapshot model.BookSnapshot) {
	t.Helper()
	for i, level := range snapshot.Bids {
		if level.PriceTicks < 10_000 || level.PriceTicks > 10_000_000 {
			t.Fatalf("bid %d price = %d, want within limits", i, level.PriceTicks)
		}
		if i > 0 && snapshot.Bids[i-1].PriceTicks <= level.PriceTicks {
			t.Fatalf("bids not descending at %d: %+v", i, snapshot.Bids)
		}
	}
	for i, level := range snapshot.Asks {
		if level.PriceTicks < 10_000 || level.PriceTicks > 10_000_000 {
			t.Fatalf("ask %d price = %d, want within limits", i, level.PriceTicks)
		}
		if i > 0 && snapshot.Asks[i-1].PriceTicks >= level.PriceTicks {
			t.Fatalf("asks not ascending at %d: %+v", i, snapshot.Asks)
		}
	}
	if len(snapshot.Bids) > 0 && len(snapshot.Asks) > 0 && snapshot.Bids[0].PriceTicks >= snapshot.Asks[0].PriceTicks {
		t.Fatalf("book crossed: %+v", snapshot)
	}
}

func assertLevelCaps(t *testing.T, snapshot model.BookSnapshot, maxLevelLots int64) {
	t.Helper()
	for _, level := range append(append([]model.Level(nil), snapshot.Bids...), snapshot.Asks...) {
		if level.QuantityLots <= 0 || level.QuantityLots > maxLevelLots {
			t.Fatalf("level %+v outside quantity cap 1..%d", level, maxLevelLots)
		}
	}
}

func assertPassiveMaintenanceChanges(t *testing.T, before model.BookSnapshot, changes []model.LevelChange) {
	t.Helper()
	replayed := cloneMaintenanceBook(before)
	for _, change := range changes {
		if change.QuantityLots == 0 {
			applyMaintenanceChange(t, &replayed, change)
			continue
		}
		switch change.Side {
		case model.BookSideBid:
			if len(replayed.Asks) > 0 && change.PriceTicks >= replayed.Asks[0].PriceTicks {
				t.Fatalf("maintenance bid change %+v crosses current best ask %+v", change, replayed.Asks[0])
			}
			if !hasMaintenanceLevel(replayed.Bids, change.PriceTicks) && change.QuantityLots != seededMaintenanceQuantity(len(replayed.Bids)+1) {
				t.Fatalf("maintenance bid add %+v quantity, want seeded %d", change, seededMaintenanceQuantity(len(replayed.Bids)+1))
			}
		case model.BookSideAsk:
			if len(replayed.Bids) > 0 && change.PriceTicks <= replayed.Bids[0].PriceTicks {
				t.Fatalf("maintenance ask change %+v crosses current best bid %+v", change, replayed.Bids[0])
			}
			if !hasMaintenanceLevel(replayed.Asks, change.PriceTicks) && change.QuantityLots != seededMaintenanceQuantity(len(replayed.Asks)+1) {
				t.Fatalf("maintenance ask add %+v quantity, want seeded %d", change, seededMaintenanceQuantity(len(replayed.Asks)+1))
			}
		default:
			t.Fatalf("maintenance change has invalid side: %+v", change)
		}
		applyMaintenanceChange(t, &replayed, change)
	}
}

func applyMaintenanceChange(t *testing.T, book *model.BookSnapshot, change model.LevelChange) {
	t.Helper()
	book.Seq = change.Seq
	switch change.Side {
	case model.BookSideBid:
		book.Bids = applyMaintenanceLevel(book.Bids, change.PriceTicks, change.QuantityLots, true)
	case model.BookSideAsk:
		book.Asks = applyMaintenanceLevel(book.Asks, change.PriceTicks, change.QuantityLots, false)
	default:
		t.Fatalf("change side = %q", change.Side)
	}
}

func hasMaintenanceLevel(levels []model.Level, priceTicks int64) bool {
	for _, level := range levels {
		if level.PriceTicks == priceTicks {
			return true
		}
	}
	return false
}

func seededMaintenanceQuantity(index int) int64 {
	return int64(10_000 + (index%10)*1_000)
}

func assertReplayLevelChanges(t *testing.T, before model.BookSnapshot, changes []model.LevelChange, want model.BookSnapshot) {
	t.Helper()
	replayed := cloneMaintenanceBook(before)
	for _, change := range changes {
		if change.Seq != replayed.Seq+1 {
			t.Fatalf("change seq = %d after %d", change.Seq, replayed.Seq)
		}
		replayed.Seq = change.Seq
		switch change.Side {
		case model.BookSideBid:
			replayed.Bids = applyMaintenanceLevel(replayed.Bids, change.PriceTicks, change.QuantityLots, true)
		case model.BookSideAsk:
			replayed.Asks = applyMaintenanceLevel(replayed.Asks, change.PriceTicks, change.QuantityLots, false)
		default:
			t.Fatalf("change side = %q", change.Side)
		}
	}
	if !sameMaintenanceBook(replayed, want) {
		t.Fatalf("changes do not replay to snapshot\nreplayed=%+v\nwant=%+v", replayed, want)
	}
}

func cloneMaintenanceBook(snapshot model.BookSnapshot) model.BookSnapshot {
	return model.BookSnapshot{
		Seq:  snapshot.Seq,
		Bids: append([]model.Level(nil), snapshot.Bids...),
		Asks: append([]model.Level(nil), snapshot.Asks...),
	}
}

func applyMaintenanceLevel(levels []model.Level, priceTicks int64, quantityLots int64, descending bool) []model.Level {
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

func ordersByID(orders []matching.Order) map[uint64]matching.Order {
	out := make(map[uint64]matching.Order, len(orders))
	for _, order := range orders {
		out[order.ID] = order
	}
	return out
}

func assertAllExistingOrdersUnchanged(t *testing.T, before map[uint64]matching.Order, after map[uint64]matching.Order) {
	t.Helper()
	for id, oldOrder := range before {
		newOrder, exists := after[id]
		if !exists {
			t.Fatalf("existing order %d disappeared from no-cancel-needed maintenance fixture", id)
		}
		if newOrder != oldOrder {
			t.Fatalf("existing order %d changed from %+v to %+v; no-cancel-needed maintenance must not fill or resize old orders", id, oldOrder, newOrder)
		}
	}
}

func assertExactlyCanceledOrderIDs(t *testing.T, before map[uint64]matching.Order, after map[uint64]matching.Order, want []uint64) {
	t.Helper()
	wantCanceled := make(map[uint64]struct{}, len(want))
	for _, id := range want {
		wantCanceled[id] = struct{}{}
	}
	for id, oldOrder := range before {
		newOrder, exists := after[id]
		_, shouldCancel := wantCanceled[id]
		if shouldCancel {
			if exists {
				t.Fatalf("order %d still rests; want exact oldest duplicate cancellation set %v", id, want)
			}
			continue
		}
		if !exists {
			t.Fatalf("order %d disappeared; want only exact canceled IDs %v", id, want)
		}
		if newOrder != oldOrder {
			t.Fatalf("existing order %d changed from %+v to %+v; capacity maintenance may cancel exact whole orders only", id, oldOrder, newOrder)
		}
	}
	for _, id := range want {
		if _, existedBefore := before[id]; !existedBefore {
			t.Fatalf("test expected cancellation ID %d, but it was not in the fixture", id)
		}
	}
}

func assertNoZeroQuantityUpdates(t *testing.T, changes []model.LevelChange) {
	t.Helper()
	for _, change := range changes {
		if change.QuantityLots == 0 {
			t.Fatalf("no-cancel-needed maintenance emitted zero quantity update %+v; want only passive adds", change)
		}
	}
}

func sameMaintenanceBook(left model.BookSnapshot, right model.BookSnapshot) bool {
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

func sameMaintenanceOrders(left []matching.Order, right []matching.Order) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func totalRestingLots(snapshot model.BookSnapshot) int64 {
	var total int64
	for _, level := range snapshot.Bids {
		total += level.QuantityLots
	}
	for _, level := range snapshot.Asks {
		total += level.QuantityLots
	}
	return total
}

func totalChangeDelta(before model.BookSnapshot, changes []model.LevelChange) int64 {
	levels := make(map[model.BookSide]map[int64]int64)
	levels[model.BookSideBid] = make(map[int64]int64)
	levels[model.BookSideAsk] = make(map[int64]int64)
	for _, level := range before.Bids {
		levels[model.BookSideBid][level.PriceTicks] = level.QuantityLots
	}
	for _, level := range before.Asks {
		levels[model.BookSideAsk][level.PriceTicks] = level.QuantityLots
	}
	var delta int64
	for _, change := range changes {
		old := levels[change.Side][change.PriceTicks]
		delta += change.QuantityLots - old
		if change.QuantityLots == 0 {
			delete(levels[change.Side], change.PriceTicks)
		} else {
			levels[change.Side][change.PriceTicks] = change.QuantityLots
		}
	}
	return delta
}
