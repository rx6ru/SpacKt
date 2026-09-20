package market

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"testing"
	"time"

	"spackt/internal/model"
	"spackt/internal/sim"
)

func TestStartAnchorsLiveScheduleBeforeWarmupElapsedTime(t *testing.T) {
	cfg := normalizeConfig(Config{
		Session:        "startup-catchup-session",
		Symbol:         "BTC-USD",
		HistoryMinutes: 1,
		Step:           time.Minute,
		Retention: Retention{
			HistoryCandles: map[model.CandleInterval]int{model.Interval1s: 10, model.Interval1m: 10, model.Interval5m: 10},
			RecentTrades:   10,
			BookChanges:    10,
		},
	})
	clock := newStartupCatchupClock(time.UnixMilli(cfg.EpochMS).UTC())
	owner, err := NewOwner(cfg, clock)
	if err != nil {
		t.Fatalf("NewOwner returned error: %v", err)
	}
	owner.sim = &startupDelaySource{clock: clock, delay: 5 * time.Minute, stepMS: int64(cfg.Step / time.Millisecond)}
	defer closeOwnerDirect(t, owner)

	beforeClock := clock.current()
	if err := owner.Start(context.Background()); err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	afterClock := clock.current()
	if afterClock.Sub(beforeClock) != 5*time.Minute {
		t.Fatalf("scripted warmup clock advanced by %s, want 5m", afterClock.Sub(beforeClock))
	}
	before := owner.Current()
	if before.MarketRev != 1 {
		t.Fatalf("post-warmup revision = %d, want one scripted warmup step", before.MarketRev)
	}

	clock.emit(afterClock)
	after := waitForDirectOwnerRevisionAtLeast(t, owner, before.MarketRev+5)
	if after.MarketRev != before.MarketRev+5 {
		t.Fatalf("first live tick advanced revision by %d, want 5 missed startup steps", after.MarketRev-before.MarketRev)
	}
}

type startupCatchupClock struct {
	mu  sync.Mutex
	now time.Time
	ch  chan time.Time
}

func newStartupCatchupClock(now time.Time) *startupCatchupClock {
	return &startupCatchupClock{now: now, ch: make(chan time.Time, 1)}
}

func (c *startupCatchupClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *startupCatchupClock) Ticks() <-chan time.Time { return c.ch }

func (c *startupCatchupClock) advance(d time.Duration) time.Time {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	c.mu.Unlock()
	return now
}

func (c *startupCatchupClock) current() time.Time { return c.Now() }

func (c *startupCatchupClock) emit(at time.Time) {
	c.mu.Lock()
	c.now = at
	c.mu.Unlock()
	c.ch <- at
}

type startupDelaySource struct {
	clock  *startupCatchupClock
	delay  time.Duration
	stepMS int64
	rev    uint64
}

func (s *startupDelaySource) Next() sim.Event {
	s.rev++
	if s.rev == 1 {
		s.clock.advance(s.delay)
	}
	return sim.Event{
		Rev:    s.rev,
		TimeMS: int64(s.rev-1) * s.stepMS,
		Book: model.BookSnapshot{
			Seq:  s.rev,
			Bids: []model.Level{{PriceTicks: 10_000, QuantityLots: 1}},
			Asks: []model.Level{{PriceTicks: 10_001, QuantityLots: 1}},
		},
	}
}

func waitForDirectOwnerRevisionAtLeast(t *testing.T, owner *Owner, minimum uint64) model.Publication {
	t.Helper()
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		pub := owner.Current()
		if pub.MarketRev >= minimum {
			return pub
		}
		runtime.Gosched()
	}
	pub := owner.Current()
	t.Fatalf("market revision did not reach %d; got %d", minimum, pub.MarketRev)
	return model.Publication{}
}

func closeOwnerDirect(t *testing.T, owner *Owner) {
	t.Helper()
	if err := owner.Close(context.Background()); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("Close returned error: %v", err)
	}
}
