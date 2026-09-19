package market_test

import (
	"context"
	"errors"
	"runtime"
	"sort"
	"sync"
	"testing"
	"time"

	"spackt/internal/market"
	"spackt/internal/model"
	"spackt/internal/sim"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
	ch  chan time.Time
}

func newFakeClock(epochMS int64) *fakeClock {
	return &fakeClock{
		now: time.UnixMilli(epochMS).UTC(),
		ch:  make(chan time.Time, 1),
	}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Ticks() <-chan time.Time {
	return c.ch
}

func (c *fakeClock) advance(d time.Duration) time.Time {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	c.mu.Unlock()
	return now
}

func (c *fakeClock) emitOneTick(t *testing.T, at time.Time) {
	t.Helper()
	select {
	case c.ch <- at:
	default:
		t.Fatalf("fake clock tick channel already contains an unprocessed tick")
	}
}

func TestStartupWarmupUsesLatestInitializedTradeAsFixedReference(t *testing.T) {
	owner, clock := startOwner(t, longWarmupConfig())
	defer closeOwner(t, owner)

	pub := currentPublication(t, owner)
	if len(pub.Trades) == 0 {
		t.Fatalf("startup publication has no retained initialized trades")
	}
	latestInitialized := pub.Trades[len(pub.Trades)-1]
	if pub.ReferencePriceTicks != latestInitialized.PriceTicks {
		t.Fatalf("reference price = %d, want latest initialized trade price %d", pub.ReferencePriceTicks, latestInitialized.PriceTicks)
	}

	next := advanceOneTickAndWait(t, owner, clock, pub.MarketRev)
	if next.ReferencePriceTicks != pub.ReferencePriceTicks {
		t.Fatalf("reference price changed after live publication: got %d, want %d", next.ReferencePriceTicks, pub.ReferencePriceTicks)
	}
}

func TestLiveGenerationContinuesTheSeededSequenceAfterWarmup(t *testing.T) {
	cfg := testConfig()
	firstOwner, firstClock := startOwner(t, cfg)
	defer closeOwner(t, firstOwner)
	secondOwner, secondClock := startOwner(t, cfg)
	defer closeOwner(t, secondOwner)

	first := collectNewTrades(t, firstOwner, firstClock, 5)
	second := collectNewTrades(t, secondOwner, secondClock, 5)
	expected := collectExpectedSimulatorTrades(t, cfg, 5)

	assertTradesEqual(t, "first owner versus second owner", first, second)
	assertTradesEqual(t, "owner versus pure simulator", first, expected)
}

func TestPublishedCopiesDoNotAliasLaterOwnerState(t *testing.T) {
	owner, clock := startOwner(t, testConfig())
	defer closeOwner(t, owner)

	old := currentPublication(t, owner)
	oldBookSeq := old.Book.Seq
	oldFirstBid := old.Book.Bids[0]
	oldFirstChange := old.BookChanges[0]
	oldFirstTrade := old.Trades[0]
	oldFirstCandle := old.Candles[model.CandleInterval("1s")][0]

	advanceOneTickAndWait(t, owner, clock, old.MarketRev)
	if old.Book.Seq != oldBookSeq || old.Book.Bids[0] != oldFirstBid {
		t.Fatalf("later owner progress mutated a retained publication book")
	}
	if old.BookChanges[0] != oldFirstChange {
		t.Fatalf("later owner progress mutated retained book changes")
	}
	if old.Trades[0] != oldFirstTrade {
		t.Fatalf("later owner progress mutated retained trades")
	}
	if old.Candles[model.CandleInterval("1s")][0] != oldFirstCandle {
		t.Fatalf("later owner progress mutated retained candles")
	}

	mutated := currentPublication(t, owner)
	mutatePublication(mutated)
	next := advanceOneTickAndWait(t, owner, clock, mutated.MarketRev)
	if len(next.Book.Bids) == 0 || next.Book.Bids[0].PriceTicks == -1 {
		t.Fatalf("mutating a returned publication poisoned owner book: %#v", next.Book.Bids)
	}
	if len(next.BookChanges) == 0 || next.BookChanges[0].PriceTicks == -1 {
		t.Fatalf("mutating a returned publication poisoned book changes: %#v", next.BookChanges)
	}
	if len(next.Trades) == 0 || next.Trades[0].ID == 999999 {
		t.Fatalf("mutating a returned publication poisoned trades: %#v", next.Trades)
	}
	for _, interval := range []model.CandleInterval{"1s", "1m", "5m"} {
		if len(next.Candles[interval]) == 0 {
			t.Fatalf("mutating a returned publication deleted owner %s candles: %#v", interval, next.Candles)
		}
	}
}

func TestHistoryCaptureReturnsOwnedBoundedAscendingCandles(t *testing.T) {
	cfg := testConfig()
	owner, _ := startOwner(t, cfg)
	defer closeOwner(t, owner)

	candles, err := owner.CaptureHistory(context.Background(), model.CandleInterval("1s"), 1000)
	if err != nil {
		t.Fatalf("CaptureHistory returned error: %v", err)
	}
	if len(candles) == 0 {
		t.Fatalf("CaptureHistory returned no startup candles")
	}
	if len(candles) > cfg.Retention.HistoryCandles[model.CandleInterval("1s")] {
		t.Fatalf("history returned %d candles, want at most %d", len(candles), cfg.Retention.HistoryCandles[model.CandleInterval("1s")])
	}
	assertAscendingCandles(t, candles)

	latest := candles[len(candles)-1]
	candles[len(candles)-1].Rev = 999999
	fresh, err := owner.CaptureHistory(context.Background(), model.CandleInterval("1s"), 1)
	if err != nil {
		t.Fatalf("second CaptureHistory returned error: %v", err)
	}
	if len(fresh) != 1 {
		t.Fatalf("second CaptureHistory returned %d candles, want exactly 1", len(fresh))
	}
	if fresh[0].TimeMS != latest.TimeMS {
		t.Fatalf("second CaptureHistory latest time = %d, want %d", fresh[0].TimeMS, latest.TimeMS)
	}
	if fresh[0].Rev == 999999 {
		t.Fatalf("mutating latest returned history candle changed owner history")
	}
}

func TestCancelledCapturesDoNotStallFutureTicks(t *testing.T) {
	owner, clock := startOwner(t, testConfig())
	defer closeOwner(t, owner)

	before := currentPublication(t, owner).MarketRev
	for i := 0; i < 64; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, _ = owner.CaptureHistory(ctx, model.CandleInterval("1s"), 500)
	}

	after := advanceOneTickAndWait(t, owner, clock, before)
	if after.MarketRev <= before {
		t.Fatalf("market revision did not advance after cancelled captures: before %d after %d", before, after.MarketRev)
	}
}

func TestCurrentPublicationContainsDeliveryBoundsForAllIntervals(t *testing.T) {
	owner, _ := startOwner(t, testConfig())
	defer closeOwner(t, owner)

	pub := currentPublication(t, owner)
	if len(pub.Book.Bids) > 50 || len(pub.Book.Asks) > 50 {
		t.Fatalf("book depth = bids %d asks %d, want at most 50 per side", len(pub.Book.Bids), len(pub.Book.Asks))
	}
	if len(pub.BookChanges) > 4096 {
		t.Fatalf("book changes = %d, want at most 4096", len(pub.BookChanges))
	}
	if len(pub.Trades) > 200 {
		t.Fatalf("recent trades = %d, want at most 200", len(pub.Trades))
	}
	for _, interval := range []model.CandleInterval{"1s", "1m", "5m"} {
		candles := pub.Candles[interval]
		if len(candles) == 0 {
			t.Fatalf("publication has no %s candles", interval)
		}
		if len(candles) > 65 {
			t.Fatalf("%s candles = %d, want at most active plus 64 closed", interval, len(candles))
		}
		if candles[len(candles)-1].Closed {
			t.Fatalf("%s final delivery candle is closed, want active candle last: %#v", interval, candles[len(candles)-1])
		}
	}
}

func TestCandleRevisionsNeverExceedPublicationRevision(t *testing.T) {
	owner, _ := startOwner(t, testConfig())
	defer closeOwner(t, owner)

	pub := currentPublication(t, owner)
	if pub.MarketRev == 0 {
		t.Fatalf("market revision = 0, want positive publication identity")
	}
	for interval, candles := range pub.Candles {
		for _, candle := range candles {
			if candle.Rev == 0 {
				t.Fatalf("%s candle at %d has zero revision", interval, candle.TimeMS)
			}
			if candle.Rev > pub.MarketRev {
				t.Fatalf("%s candle rev %d exceeds publication rev %d", interval, candle.Rev, pub.MarketRev)
			}
		}
	}
}

func TestClockProgressWithoutTradeAdvancesPublicationIdentity(t *testing.T) {
	cfg := testConfig()
	cfg.Seed = 3
	owner, clock := startOwner(t, cfg)
	defer closeOwner(t, owner)

	before := currentPublication(t, owner)
	var after model.Publication
	for i := 0; i < 20; i++ {
		after = advanceOneTickAndWait(t, owner, clock, before.MarketRev)
		if after.MarketRev > before.MarketRev && after.LastTradeID == before.LastTradeID {
			return
		}
		before = after
	}
	t.Fatalf("no publication represented clock progress without a trade; last rev/id %d/%d", after.MarketRev, after.LastTradeID)
}

func TestDelayedClockTickCatchesUpElapsedLogicalSteps(t *testing.T) {
	cfg := testConfig()
	cfg.Step = 100 * time.Millisecond
	owner, clock := startOwner(t, cfg)
	defer closeOwner(t, owner)

	before := currentPublication(t, owner)
	at := clock.advance(500 * time.Millisecond)
	clock.emitOneTick(t, at)

	after := waitForPublicationRevisionAtLeast(t, owner, before.MarketRev+5)
	if after.MarketRev != before.MarketRev+5 {
		t.Fatalf("market revision advanced by %d, want exactly 5", after.MarketRev-before.MarketRev)
	}
	if after.TimeMS != before.TimeMS+500 {
		t.Fatalf("publication time advanced by %dms, want 500ms", after.TimeMS-before.TimeMS)
	}
}

func TestStartWithAlreadyCanceledContextReturnsContextErrorAndDoesNotBecomeReady(t *testing.T) {
	cfg := testConfig()
	clock := newFakeClock(cfg.EpochMS)
	owner, err := market.NewOwner(cfg, clock)
	if err != nil {
		t.Fatalf("NewOwner returned error: %v", err)
	}
	defer closeOwner(t, owner)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err = owner.Start(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Start returned %v, want context.Canceled", err)
	}
	if owner.Ready() {
		t.Fatalf("Ready() = true after canceled Start, want false")
	}
	if pub := owner.Current(); pub.Session != "" {
		t.Fatalf("Current after canceled Start = %#v, want zero publication", pub)
	}
}

func TestReadyFailsAfterTwoSecondsWithoutTickWhilePublicationDoesNotAdvance(t *testing.T) {
	owner, clock := startOwner(t, testConfig())
	defer closeOwner(t, owner)

	before := currentPublication(t, owner)
	clock.advance(2100 * time.Millisecond)

	if owner.Ready() {
		t.Fatalf("Ready() = true, want false after more than two seconds without owner publication")
	}
	after := currentPublication(t, owner)
	if after.MarketRev != before.MarketRev {
		t.Fatalf("market revision advanced without a tick: before %d after %d", before.MarketRev, after.MarketRev)
	}
}

func TestCaptureBookReturnsOwnedConsistentSnapshot(t *testing.T) {
	owner, _ := startOwner(t, testConfig())
	defer closeOwner(t, owner)

	capture, err := owner.CaptureBook(context.Background())
	if err != nil {
		t.Fatalf("CaptureBook returned error: %v", err)
	}
	if capture.Session == "" || capture.Symbol != "BTC-USD" {
		t.Fatalf("CaptureBook metadata = session %q symbol %q", capture.Session, capture.Symbol)
	}
	assertBookSorted(t, capture.Book)

	capture.Book.Bids[0].PriceTicks = -1
	next, err := owner.CaptureBook(context.Background())
	if err != nil {
		t.Fatalf("second CaptureBook returned error: %v", err)
	}
	if next.Book.Bids[0].PriceTicks == -1 {
		t.Fatalf("mutating captured book changed owner book")
	}
}

func TestCloseTerminatesOwnerAndReadinessFails(t *testing.T) {
	owner, _ := startOwner(t, testConfig())

	if err := owner.Close(context.Background()); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
	if owner.Ready() {
		t.Fatalf("Ready() = true after Close, want false")
	}
}

func testConfig() market.Config {
	cfg := market.DefaultConfig()
	cfg.Session = "owner-red-session"
	cfg.Symbol = "BTC-USD"
	cfg.Seed = 42
	cfg.EpochMS = 1700000000000
	cfg.HistoryMinutes = 6
	cfg.Step = 100 * time.Millisecond
	cfg.Retention = market.Retention{
		HistoryCandles: map[model.CandleInterval]int{
			"1s": 3600,
			"1m": 1440,
			"5m": 2016,
		},
		DeliveryClosedCandles:    64,
		RecentTrades:             200,
		BookChanges:              4096,
		MaximumBookLevelsPerSide: 50,
	}
	return cfg
}

func longWarmupConfig() market.Config {
	cfg := testConfig()
	cfg.HistoryMinutes = 360
	return cfg
}

func startOwner(t *testing.T, cfg market.Config) (*market.Owner, *fakeClock) {
	t.Helper()
	clock := newFakeClock(cfg.EpochMS)
	owner, err := market.NewOwner(cfg, clock)
	if err != nil {
		t.Fatalf("NewOwner returned error: %v", err)
	}
	if err := owner.Start(context.Background()); err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	if !owner.Ready() {
		t.Fatalf("owner is not ready after deterministic startup warmup")
	}
	if pub := owner.Current(); pub.Session == "" {
		t.Fatalf("Current returned zero-session publication after readiness")
	}
	return owner, clock
}

func closeOwner(t *testing.T, owner *market.Owner) {
	t.Helper()
	if err := owner.Close(context.Background()); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("Close returned error: %v", err)
	}
}

func currentPublication(t *testing.T, owner *market.Owner) model.Publication {
	t.Helper()
	pub := owner.Current()
	if pub.Session == "" {
		t.Fatalf("Current returned zero-session publication")
	}
	return pub
}

func advanceOneTickAndWait(t *testing.T, owner *market.Owner, clock *fakeClock, before uint64) model.Publication {
	t.Helper()
	at := clock.advance(100 * time.Millisecond)
	clock.emitOneTick(t, at)
	return waitForPublicationRevisionGreaterThan(t, owner, before)
}

func waitForPublicationRevisionGreaterThan(t *testing.T, owner *market.Owner, before uint64) model.Publication {
	t.Helper()
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		pub := currentPublication(t, owner)
		if pub.MarketRev > before {
			return pub
		}
		runtime.Gosched()
	}
	t.Fatalf("market revision did not advance after one emitted tick; before %d after %d", before, currentPublication(t, owner).MarketRev)
	return model.Publication{}
}

func waitForPublicationRevisionAtLeast(t *testing.T, owner *market.Owner, minimum uint64) model.Publication {
	t.Helper()
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		pub := currentPublication(t, owner)
		if pub.MarketRev >= minimum {
			return pub
		}
		runtime.Gosched()
	}
	t.Fatalf("market revision did not reach %d; got %d", minimum, currentPublication(t, owner).MarketRev)
	return model.Publication{}
}

func collectNewTrades(t *testing.T, owner *market.Owner, clock *fakeClock, count int) []model.Trade {
	t.Helper()
	seen := currentPublication(t, owner).LastTradeID
	var trades []model.Trade
	for i := 0; i < 200 && len(trades) < count; i++ {
		pub := advanceOneTickAndWait(t, owner, clock, currentPublication(t, owner).MarketRev)
		for _, trade := range pub.Trades {
			if trade.ID > seen {
				trades = append(trades, trade)
			}
		}
		if pub.LastTradeID > seen {
			seen = pub.LastTradeID
		}
	}
	if len(trades) < count {
		t.Fatalf("generated %d new trades, want %d", len(trades), count)
	}
	return trades[:count]
}

func collectExpectedSimulatorTrades(t *testing.T, cfg market.Config, count int) []model.Trade {
	t.Helper()
	simulator := sim.New(sim.Config{
		Seed:     cfg.Seed,
		EpochMS:  cfg.EpochMS,
		MidTicks: 6400000,
		StepMS:   int64(cfg.Step / time.Millisecond),
	})
	warmupSteps := int((time.Duration(cfg.HistoryMinutes) * time.Minute) / cfg.Step)
	for i := 0; i < warmupSteps; i++ {
		simulator.Next()
	}

	var trades []model.Trade
	for i := 0; i < 200 && len(trades) < count; i++ {
		event := simulator.Next()
		if event.Trade != nil {
			trades = append(trades, *event.Trade)
		}
	}
	if len(trades) < count {
		t.Fatalf("simulator generated %d trades, want %d", len(trades), count)
	}
	return trades[:count]
}

func mutatePublication(pub model.Publication) {
	if len(pub.Book.Bids) > 0 {
		pub.Book.Bids[0].PriceTicks = -1
	}
	if len(pub.BookChanges) > 0 {
		pub.BookChanges[0].PriceTicks = -1
		pub.BookChanges[0].QuantityLots = -1
		pub.BookChanges[0].Side = model.BookSide("ask")
	}
	if len(pub.Trades) > 0 {
		pub.Trades[0].ID = 999999
	}
	if candles := pub.Candles[model.CandleInterval("1s")]; len(candles) > 0 {
		candles[0].Rev = 999999
	}
	delete(pub.Candles, model.CandleInterval("1m"))
}

func assertTradesEqual(t *testing.T, label string, got []model.Trade, want []model.Trade) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s length = %d, want %d", label, len(got), len(want))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%s trade %d differs:\ngot:  %#v\nwant: %#v", label, i, got[i], want[i])
		}
	}
}

func assertAscendingCandles(t *testing.T, candles []model.Candle) {
	t.Helper()
	if !sort.SliceIsSorted(candles, func(i, j int) bool {
		return candles[i].TimeMS < candles[j].TimeMS
	}) {
		t.Fatalf("candles are not ascending by time: %#v", candles)
	}
	for i := 1; i < len(candles); i++ {
		if candles[i].TimeMS == candles[i-1].TimeMS {
			t.Fatalf("candles contain duplicate time %d", candles[i].TimeMS)
		}
	}
}

func assertBookSorted(t *testing.T, book model.BookSnapshot) {
	t.Helper()
	if len(book.Bids) == 0 || len(book.Asks) == 0 {
		t.Fatalf("book is missing one side: %#v", book)
	}
	for i := 1; i < len(book.Bids); i++ {
		if book.Bids[i-1].PriceTicks <= book.Bids[i].PriceTicks {
			t.Fatalf("bids not strictly descending: %#v", book.Bids)
		}
	}
	for i := 1; i < len(book.Asks); i++ {
		if book.Asks[i-1].PriceTicks >= book.Asks[i].PriceTicks {
			t.Fatalf("asks not strictly ascending: %#v", book.Asks)
		}
	}
	if book.Bids[0].PriceTicks >= book.Asks[0].PriceTicks {
		t.Fatalf("book crossed: best bid %d best ask %d", book.Bids[0].PriceTicks, book.Asks[0].PriceTicks)
	}
}
