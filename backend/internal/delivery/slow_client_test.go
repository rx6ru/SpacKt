package delivery

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"spackt/internal/market"
	"spackt/internal/model"
)

func TestBlockedMarketWriteDoesNotStopOtherConnectionOrOwnerProgress(t *testing.T) {
	owner, clock := startDeliveryOwner(t)
	defer closeDeliveryOwner(t, owner)

	slowSink := newBlockingMarketSink()
	fastSink := newConnectionFrameSink()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	slowControls := make(chan Control)
	fastControls := make(chan Control)
	slowDone := runConnection(ctx, NewConnection("slow-client", owner, slowSink, ConnectionOptions{}), slowControls)
	fastDone := runConnection(ctx, NewConnection("fast-client", owner, fastSink, ConnectionOptions{}), fastControls)
	t.Cleanup(func() {
		slowSink.releaseBlockedWrite()
		cancel()
		requireConnectionDone(t, "slow client", slowDone, time.Second)
		requireConnectionDone(t, "fast client", fastDone, time.Second)
	})

	requireBlockingSinkFrame(t, slowSink, FrameHello, time.Second)
	requireConnectionFrame(t, fastSink, FrameHello, time.Second)
	blockedFrame := requireBlockedMarketWrite(t, slowSink, 1200*time.Millisecond)
	beforeRev := blockedFrame.MarketRev

	after := advanceDeliveryOwnerOneTick(t, owner, clock, beforeRev)
	delivered := requireUpdateAtRevision(t, fastSink, after.MarketRev, 1200*time.Millisecond)
	if delivered.MarketRev < after.MarketRev {
		t.Fatalf("fast client market revision = %d, want at least %d", delivered.MarketRev, after.MarketRev)
	}

	slowSink.releaseBlockedWrite()
	cancel()
}

type deliveryFakeClock struct {
	mu  sync.Mutex
	now time.Time
	ch  chan time.Time
}

func newDeliveryFakeClock(epochMS int64) *deliveryFakeClock {
	return &deliveryFakeClock{
		now: time.UnixMilli(epochMS).UTC(),
		ch:  make(chan time.Time, 1),
	}
}

func (c *deliveryFakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *deliveryFakeClock) Ticks() <-chan time.Time {
	return c.ch
}

func (c *deliveryFakeClock) advance(d time.Duration) time.Time {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	c.mu.Unlock()
	return now
}

func (c *deliveryFakeClock) emitOneTick(t *testing.T, at time.Time) {
	t.Helper()
	select {
	case c.ch <- at:
	default:
		t.Fatal("fake clock tick channel already contains an unprocessed tick")
	}
}

func startDeliveryOwner(t *testing.T) (*market.Owner, *deliveryFakeClock) {
	t.Helper()
	cfg := market.DefaultConfig()
	cfg.Session = "delivery-slow-client-session"
	cfg.Symbol = "BTC-USD"
	cfg.Seed = 42
	cfg.EpochMS = 1700000000000
	cfg.HistoryMinutes = 6
	cfg.Step = 100 * time.Millisecond
	cfg.Retention = market.Retention{
		HistoryCandles: map[model.CandleInterval]int{
			model.Interval1s: 3600,
			model.Interval1m: 1440,
			model.Interval5m: 2016,
		},
		DeliveryClosedCandles:    64,
		RecentTrades:             200,
		BookChanges:              4096,
		MaximumBookLevelsPerSide: 50,
	}
	clock := newDeliveryFakeClock(cfg.EpochMS)
	owner, err := market.NewOwner(cfg, clock)
	if err != nil {
		t.Fatalf("NewOwner returned error: %v", err)
	}
	if err := owner.Start(context.Background()); err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	if !owner.Ready() {
		t.Fatal("owner is not ready after deterministic startup warmup")
	}
	return owner, clock
}

func closeDeliveryOwner(t *testing.T, owner *market.Owner) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := owner.Close(ctx); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("Close returned error: %v", err)
	}
}

func advanceDeliveryOwnerOneTick(t *testing.T, owner *market.Owner, clock *deliveryFakeClock, before uint64) model.Publication {
	t.Helper()
	at := clock.advance(100 * time.Millisecond)
	clock.emitOneTick(t, at)
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		pub := owner.Current()
		if pub.MarketRev > before {
			return pub
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			t.Fatalf("market revision did not advance after blocked client write; before %d after %d", before, owner.Current().MarketRev)
		}
	}
}

type blockingMarketSink struct {
	mu       sync.Mutex
	frames   chan Frame
	entered  chan Frame
	release  chan struct{}
	released bool
}

func newBlockingMarketSink() *blockingMarketSink {
	return &blockingMarketSink{
		frames:  make(chan Frame, 128),
		entered: make(chan Frame, 1),
		release: make(chan struct{}),
	}
}

func (s *blockingMarketSink) Write(ctx context.Context, frame Frame) (time.Duration, error) {
	if frame.Kind != FrameUpdate {
		s.frames <- frame
		return 10 * time.Millisecond, nil
	}

	s.mu.Lock()
	released := s.released
	s.mu.Unlock()
	if released {
		s.frames <- frame
		return 10 * time.Millisecond, nil
	}

	blockedAt := time.Now()
	select {
	case s.entered <- frame:
	default:
	}
	select {
	case <-s.release:
		s.frames <- frame
		return time.Since(blockedAt), nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func (s *blockingMarketSink) releaseBlockedWrite() {
	s.mu.Lock()
	if !s.released {
		close(s.release)
		s.released = true
	}
	s.mu.Unlock()
}

func requireBlockingSinkFrame(t *testing.T, sink *blockingMarketSink, kind FrameKind, timeout time.Duration) Frame {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case frame := <-sink.frames:
			if frame.Kind == kind {
				return frame
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s frame", kind)
		}
	}
}

func requireBlockedMarketWrite(t *testing.T, sink *blockingMarketSink, timeout time.Duration) Frame {
	t.Helper()
	select {
	case frame := <-sink.entered:
		return frame
	case <-time.After(timeout):
		t.Fatal("timed out waiting for blocked market write")
	}
	return Frame{}
}

func requireUpdateAtRevision(t *testing.T, sink *connectionFrameSink, minimum uint64, timeout time.Duration) Frame {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case frame := <-sink.frames:
			if frame.Kind == FrameUpdate && frame.MarketRev >= minimum {
				return frame
			}
		case <-deadline:
			t.Fatalf("timed out waiting for update at market revision at least %d", minimum)
		}
	}
}

func requireConnectionDone(t *testing.T, label string, done <-chan CloseResult, timeout time.Duration) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatalf("%s did not stop within %s", label, timeout)
	}
}
