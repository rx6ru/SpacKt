package delivery

import (
	"context"
	"sync"
	"testing"
	"time"

	"spackt/internal/model"
)

func TestConnectionDowngradesFromInitialDegradedToMinimalAfterMissingReportsByTimer(t *testing.T) {
	source := newConnectionStateSource(publicationWithAllStreams())
	sink := newConnectionFrameSink()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	controls := make(chan Control)
	done := runConnection(ctx, NewConnection("conn-a", source, sink, ConnectionOptions{}), controls)

	requireConnectionFrame(t, sink, FrameHello, time.Second)
	tier := requirePolicyFrame(t, sink, "minimal", 6*time.Second)

	if tier.Policy.Auto != "minimal" || tier.Policy.Reason == "" {
		t.Fatalf("tier policy = %+v, want automatic minimal downgrade with reason", tier.Policy)
	}
	cancel()
	<-done
}

func TestConnectionRateLimitsSecondDebugCommandWithinOneSecondWithoutApplyingIt(t *testing.T) {
	source := newConnectionStateSource(publicationWithAllStreams())
	sink := newConnectionFrameSink()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	controls := make(chan Control, 2)
	done := runConnection(ctx, NewConnection("conn-a", source, sink, ConnectionOptions{DebugControls: true}), controls)
	requireConnectionFrame(t, sink, FrameHello, time.Second)

	controls <- Control{Kind: "debug", Action: "forceTier", Value: "full"}
	requirePolicyFrame(t, sink, "full", time.Second)
	controls <- Control{Kind: "debug", Action: "forceTier", Value: "minimal"}

	errFrame := requireErrorFrame(t, sink, "rate_limited", time.Second)
	if errFrame.Policy != nil && errFrame.Policy.Forced != nil && *errFrame.Policy.Forced == "minimal" {
		t.Fatalf("rate-limited debug command applied forced tier: %+v", errFrame.Policy)
	}
	requireNoPolicyFrame(t, sink, "minimal", 250*time.Millisecond)

	cancel()
	<-done
}

func TestConnectionIgnoresSlowHelloAndControlWritesForBackpressureButDowngradesSlowMarketWrite(t *testing.T) {
	source := newConnectionStateSource(publicationWithAllStreams())
	sink := newConnectionFrameSink()
	sink.durationFor = func(frame Frame) time.Duration {
		if frame.Kind == FrameUpdate {
			return 10 * time.Millisecond
		}
		return 1100 * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	controls := make(chan Control, 2)
	done := runConnection(ctx, NewConnection("conn-a", source, sink, ConnectionOptions{DebugControls: true}), controls)
	requireConnectionFrame(t, sink, FrameHello, time.Second)

	controls <- Control{Kind: "debug", Action: "forceTier", Value: "full"}
	forcedFull := requirePolicyFrame(t, sink, "full", time.Second)
	if forcedFull.Policy.Auto != "degraded" || forcedFull.Policy.Reason == "" {
		t.Fatalf("forced-full policy after slow control write = %+v, want auto degraded and non-empty reason", forcedFull.Policy)
	}
	requireNoPolicyFrame(t, sink, "minimal", 250*time.Millisecond)

	sink.mu.Lock()
	sink.durationFor = func(frame Frame) time.Duration {
		if frame.Kind == FrameUpdate {
			return 1100 * time.Millisecond
		}
		return 10 * time.Millisecond
	}
	sink.mu.Unlock()
	source.set(publicationWithTrades(21, trades(1, 4)))

	requireConnectionFrame(t, sink, FrameUpdate, 1200*time.Millisecond)
	tier := requireAutoPolicyFrame(t, sink, "minimal", time.Second)
	if tier.Policy.Auto != "minimal" {
		t.Fatalf("tier policy after slow market write = %+v, want auto minimal", tier.Policy)
	}

	cancel()
	<-done
}

func TestConnectionDropNextBookDeltaPersistsThroughBookResetAndOmitsNextRealBookPayload(t *testing.T) {
	source := newConnectionStateSource(publicationWithAllStreams())
	sink := newConnectionFrameSink()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	controls := make(chan Control, 3)
	done := runConnection(ctx, NewConnection("conn-a", source, sink, ConnectionOptions{DebugControls: true}), controls)
	requireConnectionFrame(t, sink, FrameHello, time.Second)

	source.set(publicationWithBookChangesAndTrades(11, []model.LevelChange{
		{Seq: 11, Side: model.BookSideBid, PriceTicks: 100, QuantityLots: 2},
	}, trades(1, 3)))
	requireConnectionFrame(t, sink, FrameUpdate, 1200*time.Millisecond)

	controls <- Control{Kind: "debug", Action: "dropNextBookDelta"}
	source.set(publicationWithBookChangesAndTrades(5000, logTail(905, 5000), trades(1, 3)))
	reset := requireConnectionFrame(t, sink, FrameBookReset, 1200*time.Millisecond)
	if reset.BookReset == nil || reset.BookReset.Reason != "cursor_expired" {
		t.Fatalf("book reset = %+v, want cursor_expired", reset.BookReset)
	}

	source.set(publicationWithBookChangesAndTrades(5001, []model.LevelChange{
		{Seq: 5001, Side: model.BookSideBid, PriceTicks: 101, QuantityLots: 8},
	}, trades(1, 4)))
	droppedBookUpdate := requireUpdateWithTradeID(t, sink, 4, 1200*time.Millisecond)
	if droppedBookUpdate.Book != nil {
		t.Fatalf("first update after reset/dropNextBookDelta included book payload: %+v", droppedBookUpdate.Book)
	}

	source.set(publicationWithBookChangesAndTrades(5002, []model.LevelChange{
		{Seq: 5002, Side: model.BookSideBid, PriceTicks: 102, QuantityLots: 9},
	}, trades(1, 5)))
	resumedBookUpdate := requireUpdateWithTradeID(t, sink, 5, 1200*time.Millisecond)
	if resumedBookUpdate.Book == nil || resumedBookUpdate.Book.From != 5002 || resumedBookUpdate.Book.To != 5002 {
		t.Fatalf("second update after reset/dropNextBookDelta book = %+v, want 5002..5002", resumedBookUpdate.Book)
	}

	cancel()
	<-done
}

type connectionStateSource struct {
	mu      sync.Mutex
	current model.Publication
}

func newConnectionStateSource(initial model.Publication) *connectionStateSource {
	return &connectionStateSource{current: initial}
}

func publicationWithBookChangesAndTrades(bookSeq uint64, changes []model.LevelChange, items []model.Trade) model.Publication {
	pub := publicationWithBookChanges(bookSeq, changes)
	pub.Trades = items
	pub.LastTradeID = items[len(items)-1].ID
	return pub
}

func (s *connectionStateSource) Current() model.Publication {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

func (s *connectionStateSource) set(next model.Publication) {
	s.mu.Lock()
	s.current = next
	s.mu.Unlock()
}

type connectionFrameSink struct {
	mu          sync.Mutex
	frames      chan Frame
	durationFor func(Frame) time.Duration
}

func newConnectionFrameSink() *connectionFrameSink {
	return &connectionFrameSink{
		frames: make(chan Frame, 128),
		durationFor: func(Frame) time.Duration {
			return 10 * time.Millisecond
		},
	}
}

func (s *connectionFrameSink) Write(_ context.Context, frame Frame) (time.Duration, error) {
	s.mu.Lock()
	durationFor := s.durationFor
	s.mu.Unlock()

	s.frames <- frame
	return durationFor(frame), nil
}

func runConnection(ctx context.Context, conn interface {
	Run(context.Context, <-chan Control) CloseResult
}, controls <-chan Control) <-chan CloseResult {
	done := make(chan CloseResult, 1)
	go func() {
		done <- conn.Run(ctx, controls)
	}()
	return done
}

func requireConnectionFrame(t *testing.T, sink *connectionFrameSink, kind FrameKind, timeout time.Duration) Frame {
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

func requirePolicyFrame(t *testing.T, sink *connectionFrameSink, effective string, timeout time.Duration) Frame {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case frame := <-sink.frames:
			if frame.Policy != nil && frame.Policy.Effective == effective {
				return frame
			}
		case <-deadline:
			t.Fatalf("timed out waiting for policy effective %s", effective)
		}
	}
}

func requireAutoPolicyFrame(t *testing.T, sink *connectionFrameSink, auto string, timeout time.Duration) Frame {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case frame := <-sink.frames:
			if frame.Policy != nil && frame.Policy.Auto == auto {
				return frame
			}
		case <-deadline:
			t.Fatalf("timed out waiting for policy auto %s", auto)
		}
	}
}

func requireNoPolicyFrame(t *testing.T, sink *connectionFrameSink, effective string, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case frame := <-sink.frames:
			if frame.Policy != nil && frame.Policy.Effective == effective {
				t.Fatalf("unexpected policy effective %s frame: %+v", effective, frame)
			}
		case <-deadline:
			return
		}
	}
}

func requireErrorFrame(t *testing.T, sink *connectionFrameSink, code string, timeout time.Duration) Frame {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case frame := <-sink.frames:
			if frame.Error != nil && frame.Error.Code == code {
				return frame
			}
		case <-deadline:
			t.Fatalf("timed out waiting for error code %s", code)
		}
	}
}

func requireUpdateWithTradeID(t *testing.T, sink *connectionFrameSink, tradeID uint64, timeout time.Duration) Frame {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case frame := <-sink.frames:
			if frame.Kind != FrameUpdate {
				continue
			}
			for _, trade := range frame.Trades {
				if trade.ID == tradeID {
					return frame
				}
			}
		case <-deadline:
			t.Fatalf("timed out waiting for update containing trade ID %d", tradeID)
		}
	}
}
