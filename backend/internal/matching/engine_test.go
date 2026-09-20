package matching

import (
	"errors"
	"reflect"
	"testing"

	"spackt/internal/model"
)

func defaultLimits() Limits {
	return Limits{
		MinPriceTicks: 10_000,
		MaxPriceTicks: 10_000_000,
		MaxOrderLots:  100_000,
		MaxLevelLots:  100_000,
		MaxOrders:     1024,
	}
}

func smallLimits() Limits {
	limits := defaultLimits()
	limits.MaxOrderLots = 20
	limits.MaxLevelLots = 20
	limits.MaxOrders = 8
	return limits
}

func newEngine(t *testing.T, limits Limits) *Engine {
	t.Helper()
	engine, err := New(limits)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	requireBookInvariants(t, engine)
	return engine
}

func mustSubmit(t *testing.T, engine *Engine, side Side, priceTicks int64, quantityLots int64) Result {
	t.Helper()
	before := snapshotState(engine)
	result, err := engine.Submit(side, priceTicks, quantityLots)
	if err != nil {
		t.Fatalf("Submit(%s, %d, %d) error = %v", side, priceTicks, quantityLots, err)
	}
	if result.OrderID == 0 {
		t.Fatalf("accepted order got zero order ID")
	}
	if len(result.Fills) == 0 && result.RemainingLots != quantityLots {
		t.Fatalf("passive order remaining = %d, want %d", result.RemainingLots, quantityLots)
	}
	if len(result.Fills) > 0 {
		filled := int64(0)
		for _, fill := range result.Fills {
			if fill.QuantityLots <= 0 {
				t.Fatalf("fill has nonpositive quantity: %+v", fill)
			}
			filled += fill.QuantityLots
		}
		if filled+result.RemainingLots != quantityLots {
			t.Fatalf("fill conservation got fills %d + remainder %d, want %d", filled, result.RemainingLots, quantityLots)
		}
	}
	requireContiguousChanges(t, before.book.Seq, result.BookChanges)
	requireBookInvariants(t, engine)
	return result
}

func mustCancel(t *testing.T, engine *Engine, orderID uint64) []model.LevelChange {
	t.Helper()
	before := snapshotState(engine)
	changes, err := engine.Cancel(orderID)
	if err != nil {
		t.Fatalf("Cancel(%d) error = %v", orderID, err)
	}
	requireContiguousChanges(t, before.book.Seq, changes)
	requireBookInvariants(t, engine)
	return changes
}

func requireErrorNoMutation(t *testing.T, engine *Engine, action func() error) {
	t.Helper()
	before := snapshotState(engine)
	if err := action(); err == nil {
		t.Fatalf("action succeeded, want error")
	}
	after := snapshotState(engine)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("state mutated after rejection\nbefore: %+v\nafter:  %+v", before, after)
	}
}

func requireErrorIsNoMutation(t *testing.T, engine *Engine, want error, action func() error) {
	t.Helper()
	before := snapshotState(engine)
	err := action()
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want errors.Is(..., %v)", err, want)
	}
	after := snapshotState(engine)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("state mutated after rejection\nbefore: %+v\nafter:  %+v", before, after)
	}
}

func TestNewValidatesLimitsAndStartsEmpty(t *testing.T) {
	limits := defaultLimits()
	engine := newEngine(t, limits)

	if got := engine.Snapshot(); !reflect.DeepEqual(got, model.BookSnapshot{}) {
		t.Fatalf("Snapshot() = %+v, want empty snapshot", got)
	}
	if got := engine.Orders(); len(got) != 0 {
		t.Fatalf("Orders() length = %d, want 0", len(got))
	}

	tests := []struct {
		name   string
		limits Limits
	}{
		{name: "zero min price", limits: Limits{MinPriceTicks: 0, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: limits.MaxOrderLots, MaxLevelLots: limits.MaxLevelLots, MaxOrders: limits.MaxOrders}},
		{name: "negative min price", limits: Limits{MinPriceTicks: -1, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: limits.MaxOrderLots, MaxLevelLots: limits.MaxLevelLots, MaxOrders: limits.MaxOrders}},
		{name: "reversed price range", limits: Limits{MinPriceTicks: limits.MaxPriceTicks, MaxPriceTicks: limits.MinPriceTicks, MaxOrderLots: limits.MaxOrderLots, MaxLevelLots: limits.MaxLevelLots, MaxOrders: limits.MaxOrders}},
		{name: "zero max order lots", limits: Limits{MinPriceTicks: limits.MinPriceTicks, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: 0, MaxLevelLots: limits.MaxLevelLots, MaxOrders: limits.MaxOrders}},
		{name: "negative max order lots", limits: Limits{MinPriceTicks: limits.MinPriceTicks, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: -1, MaxLevelLots: limits.MaxLevelLots, MaxOrders: limits.MaxOrders}},
		{name: "zero max level lots", limits: Limits{MinPriceTicks: limits.MinPriceTicks, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: limits.MaxOrderLots, MaxLevelLots: 0, MaxOrders: limits.MaxOrders}},
		{name: "order above level", limits: Limits{MinPriceTicks: limits.MinPriceTicks, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: limits.MaxLevelLots + 1, MaxLevelLots: limits.MaxLevelLots, MaxOrders: limits.MaxOrders}},
		{name: "level above safe integer", limits: Limits{MinPriceTicks: limits.MinPriceTicks, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: limits.MaxOrderLots, MaxLevelLots: int64(maxSafeInteger) + 1, MaxOrders: limits.MaxOrders}},
		{name: "zero max orders", limits: Limits{MinPriceTicks: limits.MinPriceTicks, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: limits.MaxOrderLots, MaxLevelLots: limits.MaxLevelLots, MaxOrders: 0}},
		{name: "negative max orders", limits: Limits{MinPriceTicks: limits.MinPriceTicks, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: limits.MaxOrderLots, MaxLevelLots: limits.MaxLevelLots, MaxOrders: -1}},
		{name: "too many max orders", limits: Limits{MinPriceTicks: limits.MinPriceTicks, MaxPriceTicks: limits.MaxPriceTicks, MaxOrderLots: limits.MaxOrderLots, MaxLevelLots: limits.MaxLevelLots, MaxOrders: 1025}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := New(test.limits); !errors.Is(err, ErrInvalidLimits) {
				t.Fatalf("New() error = %v, want ErrInvalidLimits for %+v", err, test.limits)
			}
		})
	}
}

func TestOrderCountTracksActiveRestingOrdersWithoutCopy(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	if got := engine.OrderCount(); got != 0 {
		t.Fatalf("empty OrderCount() = %d, want 0", got)
	}

	firstAsk := mustSubmit(t, engine, Sell, 10_100, 10_000)
	secondAsk := mustSubmit(t, engine, Sell, 10_200, 10_000)
	bid := mustSubmit(t, engine, Buy, 10_000, 5_000)
	if got := engine.OrderCount(); got != 3 {
		t.Fatalf("OrderCount() after passive additions = %d, want 3", got)
	}

	partial := mustSubmit(t, engine, Buy, 10_100, 4_000)
	if partial.RemainingLots != 0 {
		t.Fatalf("partial fill incoming remainder = %d, want 0", partial.RemainingLots)
	}
	if got := engine.OrderCount(); got != 3 {
		t.Fatalf("OrderCount() after partial maker fill = %d, want unchanged 3", got)
	}

	remainder := mustSubmit(t, engine, Buy, 10_100, 10_000)
	if remainder.RemainingLots != 4_000 {
		t.Fatalf("resting remainder = %d, want 4000", remainder.RemainingLots)
	}
	if got := engine.OrderCount(); got != 3 {
		t.Fatalf("OrderCount() after exhausted maker plus resting remainder = %d, want 3", got)
	}

	mustCancel(t, engine, bid.OrderID)
	if got := engine.OrderCount(); got != 2 {
		t.Fatalf("OrderCount() after cancel = %d, want 2", got)
	}

	before := engine.OrderCount()
	requireErrorIsNoMutation(t, engine, ErrInvalidOrder, func() error {
		_, err := engine.Submit(Buy, 0, 1)
		return err
	})
	if got := engine.OrderCount(); got != before {
		t.Fatalf("OrderCount() after rejected submit = %d, want unchanged %d", got, before)
	}
	requireErrorIsNoMutation(t, engine, ErrUnknownOrder, func() error {
		_, err := engine.Cancel(999_999)
		return err
	})
	if got := engine.OrderCount(); got != before {
		t.Fatalf("OrderCount() after rejected cancel = %d, want unchanged %d", got, before)
	}

	mustCancel(t, engine, secondAsk.OrderID)
	if got := engine.OrderCount(); got != 1 {
		t.Fatalf("OrderCount() after canceling second ask = %d, want 1", got)
	}
	_ = firstAsk
}

func TestUserExampleMatchesBuyAgainstRestingAsk(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	ask := mustSubmit(t, engine, Sell, 10_100, 20_000)
	bid := mustSubmit(t, engine, Buy, 10_000, 30_000)

	result := mustSubmit(t, engine, Buy, 10_100, 10_000)

	requireFills(t, result.Fills, []Fill{{MakerOrderID: ask.OrderID, PriceTicks: 10_100, QuantityLots: 10_000}})
	requireResult(t, result, 3, 0, []model.LevelChange{{
		Seq: 3, Side: model.BookSideAsk, PriceTicks: 10_100, QuantityLots: 10_000,
	}})
	requireBook(t, engine.Snapshot(),
		[]model.Level{{PriceTicks: 10_000, QuantityLots: 30_000}},
		[]model.Level{{PriceTicks: 10_100, QuantityLots: 10_000}},
	)
	requireOrders(t, engine.Orders(), []Order{
		{ID: ask.OrderID, Side: Sell, PriceTicks: 10_100, RemainingLots: 10_000},
		{ID: bid.OrderID, Side: Buy, PriceTicks: 10_000, RemainingLots: 30_000},
	})
}

func TestPriceImprovementUsesRestingPrice(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	ask := mustSubmit(t, engine, Sell, 10_100, 4_000)

	result := mustSubmit(t, engine, Buy, 10_200, 4_000)

	requireFills(t, result.Fills, []Fill{{MakerOrderID: ask.OrderID, PriceTicks: 10_100, QuantityLots: 4_000}})
	requireBook(t, engine.Snapshot(), nil, nil)
}

func TestBestPriceBeforeFIFO(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	worse := mustSubmit(t, engine, Sell, 10_200, 4_000)
	better := mustSubmit(t, engine, Sell, 10_100, 4_000)

	result := mustSubmit(t, engine, Buy, 10_200, 4_000)

	requireFills(t, result.Fills, []Fill{{MakerOrderID: better.OrderID, PriceTicks: 10_100, QuantityLots: 4_000}})
	requireOrders(t, engine.Orders(), []Order{{ID: worse.OrderID, Side: Sell, PriceTicks: 10_200, RemainingLots: 4_000}})
}

func TestSamePriceFIFOAndProjectionReplay(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	first := mustSubmit(t, engine, Sell, 10_100, 4_000)
	second := mustSubmit(t, engine, Sell, 10_100, 6_000)
	before := engine.Snapshot()

	result := mustSubmit(t, engine, Buy, 10_100, 5_000)

	requireFills(t, result.Fills, []Fill{
		{MakerOrderID: first.OrderID, PriceTicks: 10_100, QuantityLots: 4_000},
		{MakerOrderID: second.OrderID, PriceTicks: 10_100, QuantityLots: 1_000},
	})
	requireChanges(t, result.BookChanges, []model.LevelChange{
		{Seq: 3, Side: model.BookSideAsk, PriceTicks: 10_100, QuantityLots: 6_000},
		{Seq: 4, Side: model.BookSideAsk, PriceTicks: 10_100, QuantityLots: 5_000},
	})
	replayed := replayChanges(t, before, result.BookChanges)
	if !reflect.DeepEqual(replayed, engine.Snapshot()) {
		t.Fatalf("replayed book = %+v, want %+v", replayed, engine.Snapshot())
	}
}

func TestMultiLevelSweepAndLimitStopRemainder(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	a := mustSubmit(t, engine, Sell, 10_100, 4_000)
	b := mustSubmit(t, engine, Sell, 10_100, 6_000)
	c := mustSubmit(t, engine, Sell, 10_200, 10_000)

	sweep := mustSubmit(t, engine, Buy, 10_200, 15_000)

	requireFills(t, sweep.Fills, []Fill{
		{MakerOrderID: a.OrderID, PriceTicks: 10_100, QuantityLots: 4_000},
		{MakerOrderID: b.OrderID, PriceTicks: 10_100, QuantityLots: 6_000},
		{MakerOrderID: c.OrderID, PriceTicks: 10_200, QuantityLots: 5_000},
	})
	requireBook(t, engine.Snapshot(), nil, []model.Level{{PriceTicks: 10_200, QuantityLots: 5_000}})

	engine = newEngine(t, defaultLimits())
	mustSubmit(t, engine, Sell, 10_100, 4_000)
	mustSubmit(t, engine, Sell, 10_100, 6_000)
	mustSubmit(t, engine, Sell, 10_200, 10_000)

	stopped := mustSubmit(t, engine, Buy, 10_100, 15_000)

	if stopped.RemainingLots != 5_000 {
		t.Fatalf("remaining = %d, want 5000", stopped.RemainingLots)
	}
	requireBook(t, engine.Snapshot(),
		[]model.Level{{PriceTicks: 10_100, QuantityLots: 5_000}},
		[]model.Level{{PriceTicks: 10_200, QuantityLots: 10_000}},
	)
}

func TestSymmetricSellWalksHighestBidsFirst(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	low := mustSubmit(t, engine, Buy, 10_000, 4_000)
	high := mustSubmit(t, engine, Buy, 10_100, 6_000)

	result := mustSubmit(t, engine, Sell, 10_000, 7_000)

	requireFills(t, result.Fills, []Fill{
		{MakerOrderID: high.OrderID, PriceTicks: 10_100, QuantityLots: 6_000},
		{MakerOrderID: low.OrderID, PriceTicks: 10_000, QuantityLots: 1_000},
	})
	requireBook(t, engine.Snapshot(), []model.Level{{PriceTicks: 10_000, QuantityLots: 3_000}}, nil)
}

func TestCancelPartialMiddleUnknownAndNewArrivalPriority(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	first := mustSubmit(t, engine, Sell, 10_100, 5_000)
	second := mustSubmit(t, engine, Sell, 10_100, 6_000)
	third := mustSubmit(t, engine, Sell, 10_100, 7_000)
	mustSubmit(t, engine, Buy, 10_100, 2_000)

	changes := mustCancel(t, engine, first.OrderID)
	requireChanges(t, changes, []model.LevelChange{{Seq: 5, Side: model.BookSideAsk, PriceTicks: 10_100, QuantityLots: 13_000}})
	requireErrorIsNoMutation(t, engine, ErrUnknownOrder, func() error {
		_, err := engine.Cancel(999_999)
		return err
	})
	fourth := mustSubmit(t, engine, Sell, 10_100, 8_000)

	result := mustSubmit(t, engine, Buy, 10_100, 14_000)

	requireFills(t, result.Fills, []Fill{
		{MakerOrderID: second.OrderID, PriceTicks: 10_100, QuantityLots: 6_000},
		{MakerOrderID: third.OrderID, PriceTicks: 10_100, QuantityLots: 7_000},
		{MakerOrderID: fourth.OrderID, PriceTicks: 10_100, QuantityLots: 1_000},
	})
}

func TestCancelMiddleOrderPreservesFrontAndLastFIFO(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	first := mustSubmit(t, engine, Sell, 10_100, 5_000)
	middle := mustSubmit(t, engine, Sell, 10_100, 6_000)
	last := mustSubmit(t, engine, Sell, 10_100, 7_000)

	changes := mustCancel(t, engine, middle.OrderID)

	requireChanges(t, changes, []model.LevelChange{{Seq: 4, Side: model.BookSideAsk, PriceTicks: 10_100, QuantityLots: 12_000}})
	requireOrders(t, engine.Orders(), []Order{
		{ID: first.OrderID, Side: Sell, PriceTicks: 10_100, RemainingLots: 5_000},
		{ID: last.OrderID, Side: Sell, PriceTicks: 10_100, RemainingLots: 7_000},
	})

	result := mustSubmit(t, engine, Buy, 10_100, 8_000)

	requireFills(t, result.Fills, []Fill{
		{MakerOrderID: first.OrderID, PriceTicks: 10_100, QuantityLots: 5_000},
		{MakerOrderID: last.OrderID, PriceTicks: 10_100, QuantityLots: 3_000},
	})
}

func TestRejectedSubmitDoesNotMutateOrConsumeID(t *testing.T) {
	engine := newEngine(t, smallLimits())

	requireErrorIsNoMutation(t, engine, ErrInvalidOrder, func() error {
		_, err := engine.Submit(Side("hold"), 10_100, 1)
		return err
	})
	requireErrorIsNoMutation(t, engine, ErrInvalidOrder, func() error {
		_, err := engine.Submit(Buy, 9_999, 1)
		return err
	})
	requireErrorIsNoMutation(t, engine, ErrInvalidOrder, func() error {
		_, err := engine.Submit(Buy, 10_100, 0)
		return err
	})
	requireErrorIsNoMutation(t, engine, ErrInvalidOrder, func() error {
		_, err := engine.Submit(Buy, 10_000_001, 1)
		return err
	})
	requireErrorIsNoMutation(t, engine, ErrInvalidOrder, func() error {
		_, err := engine.Submit(Buy, 10_100, 21)
		return err
	})

	result := mustSubmit(t, engine, Buy, 10_100, 1)
	if result.OrderID != 1 {
		t.Fatalf("first accepted order ID = %d, want 1", result.OrderID)
	}
}

func TestOrderAndLevelCapacityAreAtomic(t *testing.T) {
	limits := smallLimits()
	limits.MaxOrders = 1
	engine := newEngine(t, limits)
	resting := mustSubmit(t, engine, Sell, 10_100, 10)

	requireErrorIsNoMutation(t, engine, ErrCapacity, func() error {
		_, err := engine.Submit(Sell, 10_200, 1)
		return err
	})
	executing := mustSubmit(t, engine, Buy, 10_100, 10)
	requireFills(t, executing.Fills, []Fill{{MakerOrderID: resting.OrderID, PriceTicks: 10_100, QuantityLots: 10}})

	limits = smallLimits()
	limits.MaxOrderLots = 15
	limits.MaxLevelLots = 15
	engine = newEngine(t, limits)
	mustSubmit(t, engine, Sell, 10_100, 10)
	requireErrorIsNoMutation(t, engine, ErrCapacity, func() error {
		_, err := engine.Submit(Sell, 10_100, 6)
		return err
	})
	next := mustSubmit(t, engine, Sell, 10_100, 5)
	if next.OrderID != 2 {
		t.Fatalf("order ID after level-cap rejection = %d, want 2", next.OrderID)
	}
}

func TestOwnershipCopiesProtectEngineState(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	result := mustSubmit(t, engine, Sell, 10_100, 10)

	result.BookChanges[0].QuantityLots = 99
	orders := engine.Orders()
	orders[0].RemainingLots = 99
	snapshot := engine.Snapshot()
	snapshot.Asks[0].QuantityLots = 99

	requireBook(t, engine.Snapshot(), nil, []model.Level{{PriceTicks: 10_100, QuantityLots: 10}})
	requireOrders(t, engine.Orders(), []Order{{ID: result.OrderID, Side: Sell, PriceTicks: 10_100, RemainingLots: 10}})
}

type matchingCommand struct {
	side  Side
	price int64
	qty   int64
}

func TestReplayIsDeterministicAndConservesQuantities(t *testing.T) {
	commands := []matchingCommand{
		{Sell, 10_100, 4_000},
		{Sell, 10_200, 6_000},
		{Buy, 10_100, 3_000},
		{Buy, 10_200, 5_000},
		{Sell, 10_000, 2_000},
	}

	first := runTranscript(t, commands)
	second := runTranscript(t, commands)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("replay differs\nfirst:  %+v\nsecond: %+v", first, second)
	}
}

func TestContiguousProjectionReplayAfterBasicSequence(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	book := engine.Snapshot()
	for _, command := range []struct {
		side  Side
		price int64
		qty   int64
	}{
		{Sell, 10_100, 4_000},
		{Sell, 10_100, 6_000},
		{Buy, 10_100, 5_000},
		{Buy, 10_000, 2_000},
	} {
		result := mustSubmit(t, engine, command.side, command.price, command.qty)
		book = replayChanges(t, book, result.BookChanges)
		if !reflect.DeepEqual(book, engine.Snapshot()) {
			t.Fatalf("projected book = %+v, want %+v", book, engine.Snapshot())
		}
	}
}

func TestHard1024MakerBoundary(t *testing.T) {
	limits := defaultLimits()
	limits.MaxOrderLots = 2_000
	limits.MaxLevelLots = 2_000
	limits.MaxOrders = 1024
	engine := newEngine(t, limits)

	for i := 0; i < 1024; i++ {
		result := mustSubmit(t, engine, Sell, 10_100, 1)
		if result.OrderID != uint64(i+1) {
			t.Fatalf("maker ID = %d, want %d", result.OrderID, i+1)
		}
	}

	result := mustSubmit(t, engine, Buy, 10_100, 1024)

	if len(result.Fills) != 1024 {
		t.Fatalf("fill count = %d, want 1024", len(result.Fills))
	}
	if result.OrderID != 1025 {
		t.Fatalf("incoming order ID = %d, want 1025", result.OrderID)
	}
	for index, fill := range result.Fills {
		want := Fill{MakerOrderID: uint64(index + 1), PriceTicks: 10_100, QuantityLots: 1}
		if fill != want {
			t.Fatalf("fill[%d] = %+v, want %+v", index, fill, want)
		}
	}
	requireBook(t, engine.Snapshot(), nil, nil)
}

func TestBookSequenceCounterBoundaryRejectsAtomically(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	mustSubmit(t, engine, Sell, 10_100, 1)
	mustSubmit(t, engine, Sell, 10_200, 1)
	engine.nextBookSeq = maxSafeInteger

	requireErrorIsNoMutation(t, engine, ErrCounterExhausted, func() error {
		_, err := engine.Submit(Buy, 10_200, 2)
		return err
	})
}

func TestOrderIDCounterBoundaryRejectsAtomically(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	engine.nextOrderID = maxSafeInteger + 1

	requireErrorIsNoMutation(t, engine, ErrCounterExhausted, func() error {
		_, err := engine.Submit(Sell, 10_100, 1)
		return err
	})
}

func TestCancelBookSequenceCounterBoundaryRejectsAtomically(t *testing.T) {
	engine := newEngine(t, defaultLimits())
	resting := mustSubmit(t, engine, Sell, 10_100, 1)
	engine.nextBookSeq = maxSafeInteger + 1

	requireErrorIsNoMutation(t, engine, ErrCounterExhausted, func() error {
		_, err := engine.Cancel(resting.OrderID)
		return err
	})
}

type engineState struct {
	book       model.BookSnapshot
	orders     []Order
	nextOrder  uint64
	nextBookID uint64
}

func snapshotState(engine *Engine) engineState {
	return engineState{
		book:       engine.Snapshot(),
		orders:     engine.Orders(),
		nextOrder:  engine.nextOrderID,
		nextBookID: engine.nextBookSeq,
	}
}

type transcript struct {
	results []Result
	book    model.BookSnapshot
	orders  []Order
}

func runTranscript(t *testing.T, commands []matchingCommand) transcript {
	t.Helper()
	engine := newEngine(t, defaultLimits())
	results := make([]Result, 0, len(commands))
	for _, command := range commands {
		results = append(results, mustSubmit(t, engine, command.side, command.price, command.qty))
	}
	return transcript{results: results, book: engine.Snapshot(), orders: engine.Orders()}
}

func requireResult(t *testing.T, result Result, orderID uint64, remaining int64, changes []model.LevelChange) {
	t.Helper()
	if result.OrderID != orderID {
		t.Fatalf("OrderID = %d, want %d", result.OrderID, orderID)
	}
	if result.RemainingLots != remaining {
		t.Fatalf("RemainingLots = %d, want %d", result.RemainingLots, remaining)
	}
	requireChanges(t, result.BookChanges, changes)
}

func requireFills(t *testing.T, got []Fill, want []Fill) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("fills = %+v, want %+v", got, want)
	}
}

func requireChanges(t *testing.T, got []model.LevelChange, want []model.LevelChange) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("changes = %+v, want %+v", got, want)
	}
}

func requireBook(t *testing.T, got model.BookSnapshot, bids []model.Level, asks []model.Level) {
	t.Helper()
	if !reflect.DeepEqual(got.Bids, bids) || !reflect.DeepEqual(got.Asks, asks) {
		t.Fatalf("book = bids %+v asks %+v, want bids %+v asks %+v", got.Bids, got.Asks, bids, asks)
	}
}

func requireOrders(t *testing.T, got []Order, want []Order) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("orders = %+v, want %+v", got, want)
	}
}

func requireContiguousChanges(t *testing.T, previousSeq uint64, changes []model.LevelChange) {
	t.Helper()
	for index, change := range changes {
		want := previousSeq + uint64(index) + 1
		if change.Seq != want {
			t.Fatalf("change[%d].Seq = %d, want %d", index, change.Seq, want)
		}
	}
}

func requireBookInvariants(t *testing.T, engine *Engine) {
	t.Helper()
	snapshot := engine.Snapshot()
	orders := engine.Orders()
	if len(orders) > engine.limits.MaxOrders {
		t.Fatalf("orders length = %d, limit %d", len(orders), engine.limits.MaxOrders)
	}
	seen := map[uint64]bool{}
	bidLots := map[int64]int64{}
	askLots := map[int64]int64{}
	var lastID uint64
	for _, order := range orders {
		if order.ID == 0 || seen[order.ID] {
			t.Fatalf("invalid or duplicate order ID: %+v", order)
		}
		if order.ID < lastID {
			t.Fatalf("orders not sorted by ID: %+v", orders)
		}
		lastID = order.ID
		seen[order.ID] = true
		if order.RemainingLots <= 0 {
			t.Fatalf("order has nonpositive quantity: %+v", order)
		}
		if order.RemainingLots > engine.limits.MaxOrderLots {
			t.Fatalf("order quantity %d exceeds limit %d: %+v", order.RemainingLots, engine.limits.MaxOrderLots, order)
		}
		if order.PriceTicks < engine.limits.MinPriceTicks || order.PriceTicks > engine.limits.MaxPriceTicks {
			t.Fatalf("order price outside limits %+v: %+v", engine.limits, order)
		}
		switch order.Side {
		case Buy:
			bidLots[order.PriceTicks] += order.RemainingLots
		case Sell:
			askLots[order.PriceTicks] += order.RemainingLots
		default:
			t.Fatalf("invalid order side: %+v", order)
		}
	}
	requireLevels(t, snapshot.Bids, bidLots, true, engine.limits)
	requireLevels(t, snapshot.Asks, askLots, false, engine.limits)
	if len(snapshot.Bids) > 0 && len(snapshot.Asks) > 0 && snapshot.Bids[0].PriceTicks >= snapshot.Asks[0].PriceTicks {
		t.Fatalf("crossed book: bids %+v asks %+v", snapshot.Bids, snapshot.Asks)
	}
}

func requireLevels(t *testing.T, levels []model.Level, sums map[int64]int64, descending bool, limits Limits) {
	t.Helper()
	for index, level := range levels {
		if level.QuantityLots <= 0 {
			t.Fatalf("level has nonpositive quantity: %+v", level)
		}
		if level.QuantityLots > limits.MaxLevelLots {
			t.Fatalf("level quantity %d exceeds limit %d: %+v", level.QuantityLots, limits.MaxLevelLots, level)
		}
		if level.PriceTicks < limits.MinPriceTicks || level.PriceTicks > limits.MaxPriceTicks {
			t.Fatalf("level price outside limits %+v: %+v", limits, level)
		}
		if sums[level.PriceTicks] != level.QuantityLots {
			t.Fatalf("level %+v does not match order sum %d", level, sums[level.PriceTicks])
		}
		delete(sums, level.PriceTicks)
		if index > 0 {
			prev := levels[index-1].PriceTicks
			if descending && prev <= level.PriceTicks {
				t.Fatalf("levels not descending: %+v", levels)
			}
			if !descending && prev >= level.PriceTicks {
				t.Fatalf("levels not ascending: %+v", levels)
			}
		}
	}
	if len(sums) != 0 {
		t.Fatalf("order sums missing from levels: %+v", sums)
	}
}

func replayChanges(t *testing.T, snapshot model.BookSnapshot, changes []model.LevelChange) model.BookSnapshot {
	t.Helper()
	book := model.BookSnapshot{
		Seq:  snapshot.Seq,
		Bids: append([]model.Level(nil), snapshot.Bids...),
		Asks: append([]model.Level(nil), snapshot.Asks...),
	}
	for _, change := range changes {
		if change.Seq != book.Seq+1 {
			t.Fatalf("noncontiguous change seq = %d after %d", change.Seq, book.Seq)
		}
		book.Seq = change.Seq
		switch change.Side {
		case model.BookSideBid:
			book.Bids = applyLevel(book.Bids, change.PriceTicks, change.QuantityLots, true)
		case model.BookSideAsk:
			book.Asks = applyLevel(book.Asks, change.PriceTicks, change.QuantityLots, false)
		default:
			t.Fatalf("invalid change side: %+v", change)
		}
	}
	return book
}

func applyLevel(levels []model.Level, priceTicks int64, quantityLots int64, descending bool) []model.Level {
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
		if (descending && before >= after) || (!descending && before <= after) {
			break
		}
		out[i-1], out[i] = out[i], out[i-1]
	}
	return out
}
