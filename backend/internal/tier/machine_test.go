package tier

import (
	"math"
	"strings"
	"testing"
	"time"
)

func TestNewConnectionStartsDegraded(t *testing.T) {
	state := New(0).Step(Input{}, 0)

	assertState(t, state, TierDegraded, TierDegraded)
	assertFlush(t, state, 500)
	assertNoForced(t, state)
}

func TestOneQualifyingDownReportDoesNotChangeTier(t *testing.T) {
	m := NewWithAuto(0, TierFull)

	state := m.Step(Input{Report: report(450, 20, 10)}, 0)

	assertState(t, state, TierFull, TierFull)
}

func TestRepeatedDegradedBoundaryReportsForThreeSecondsDowngradeOneTier(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(450, 20, 10)}, 0)

	state := m.Step(Input{Report: report(450, 20, 10)}, 3*time.Second)

	assertState(t, state, TierDegraded, TierDegraded)
	assertFlush(t, state, 500)
	assertReasonContains(t, state, "degraded")
}

func TestFractionalLatencyAboveDegradedThresholdIsBadEvidence(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(400.5, 20, 10)}, 0)

	state := m.Step(Input{Report: report(400.5, 20, 10)}, 3*time.Second)

	assertState(t, state, TierDegraded, TierDegraded)
}

func TestInvalidReportBreaksContinuousDownwardEvidence(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(450, 20, 10)}, 0)
	m.Step(Input{Report: report(math.NaN(), 20, 10)}, time.Second)

	afterInterruptedWindow := m.Step(Input{Report: report(450, 20, 10)}, 3*time.Second)
	afterFreshWindow := m.Step(Input{Report: report(450, 20, 10)}, 6*time.Second)

	assertState(t, afterInterruptedWindow, TierFull, TierFull)
	assertState(t, afterFreshWindow, TierDegraded, TierDegraded)
}

func TestRecoveryReportsForTenSecondsUpgradeOneStep(t *testing.T) {
	m := NewWithAuto(0, TierMinimal)
	m.Step(Input{Report: report(600, 80, 10)}, 0)

	state := m.Step(Input{Report: report(600, 80, 10)}, 10*time.Second)

	assertState(t, state, TierDegraded, TierDegraded)
	assertFlush(t, state, 500)
}

func TestFractionalLatencyBelowFullRecoveryThresholdIsGoodEvidence(t *testing.T) {
	m := NewWithAuto(0, TierDegraded)
	m.Step(Input{Report: report(299.9, 39.9, 10)}, 0)

	state := m.Step(Input{Report: report(299.9, 39.9, 10)}, 10*time.Second)

	assertState(t, state, TierFull, TierFull)
}

func TestInvalidSampleCountBreaksContinuousUpgradeEvidence(t *testing.T) {
	m := NewWithAuto(0, TierMinimal)
	m.Step(Input{Report: report(600, 80, 10)}, 0)
	m.Step(Input{Report: report(600, 80, 10)}, 2*time.Second)
	m.Step(Input{Report: report(600, 80, 1)}, 9*time.Second)

	afterInterruptedWindow := m.Step(Input{Report: report(600, 80, 10)}, 12*time.Second)
	afterFreshWindow := m.Step(Input{Report: report(600, 80, 10)}, 22*time.Second)

	assertState(t, afterInterruptedWindow, TierMinimal, TierMinimal)
	assertState(t, afterFreshWindow, TierDegraded, TierDegraded)
}

func TestMissingFallbackAtMinimalClearsContinuousUpgradeEvidence(t *testing.T) {
	m := NewWithAuto(0, TierMinimal)
	m.Step(Input{Report: report(600, 80, 10)}, 0)
	m.Step(Input{Report: report(600, 80, 10)}, 2*time.Second)
	m.Step(Input{}, 7*time.Second)

	afterSilenceFallback := m.Step(Input{Report: report(600, 80, 10)}, 12*time.Second)
	m.Step(Input{Report: report(600, 80, 10)}, 14*time.Second)
	m.Step(Input{Report: report(600, 80, 10)}, 16*time.Second)
	afterFreshWindow := m.Step(Input{Report: report(600, 80, 10)}, 22*time.Second)

	assertState(t, afterSilenceFallback, TierMinimal, TierMinimal)
	assertState(t, afterFreshWindow, TierDegraded, TierDegraded)
}

func TestMissingMinimalJumpClearsContinuousUpgradeEvidence(t *testing.T) {
	m := NewWithAuto(0, TierMinimal)
	m.Step(Input{Report: report(600, 80, 10)}, 0)
	m.Step(Input{Report: report(600, 80, 10)}, 2*time.Second)
	m.Step(Input{}, 12*time.Second)

	afterMinimalFallback := m.Step(Input{Report: report(600, 80, 10)}, 12*time.Second)
	afterFreshWindow := m.Step(Input{Report: report(600, 80, 10)}, 22*time.Second)

	assertState(t, afterMinimalFallback, TierMinimal, TierMinimal)
	assertState(t, afterFreshWindow, TierDegraded, TierDegraded)
}

func TestStrictEqualityStaysInTheCurrentBand(t *testing.T) {
	m := NewWithAuto(0, TierDegraded)
	m.Step(Input{Report: report(300, 40, 10)}, 0)

	state := m.Step(Input{Report: report(300, 40, 10)}, 10*time.Second)

	assertState(t, state, TierDegraded, TierDegraded)
}

func TestMinimalBoundaryReportsCanJumpToMinimal(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(1000, 180, 10)}, 0)

	state := m.Step(Input{Report: report(1000, 180, 10)}, 3*time.Second)

	assertState(t, state, TierMinimal, TierMinimal)
	assertFlush(t, state, 2000)
	assertReasonContains(t, state, "minimal")
}

func TestMissingReportAtFiveSecondsDowngradesOnce(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(100, 10, 10)}, 0)

	atFive := m.Step(Input{}, 5*time.Second)
	atNine := m.Step(Input{}, 9*time.Second)

	assertState(t, atFive, TierDegraded, TierDegraded)
	assertState(t, atNine, TierDegraded, TierDegraded)
}

func TestInvalidReportDoesNotRefreshMissingReportDeadline(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(100, 10, 10)}, 0)
	m.Step(Input{Report: report(100, 10, 1)}, 4*time.Second)

	state := m.Step(Input{}, 5*time.Second)

	assertState(t, state, TierDegraded, TierDegraded)
}

func TestMissingReportAtTwelveSecondsReachesMinimal(t *testing.T) {
	m := NewWithAuto(0, TierFull)

	state := m.Step(Input{}, 12*time.Second)

	assertState(t, state, TierMinimal, TierMinimal)
	assertFlush(t, state, 2000)
}

func TestHiddenTabPausesMissingReportPenalty(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(100, 10, 10)}, 0)
	m.Step(Input{Hidden: boolPtr(true)}, time.Second)

	state := m.Step(Input{}, 12*time.Second)

	if state.Auto != TierFull {
		t.Fatalf("auto tier = %q, want %q because hidden silence must not penalize", state.Auto, TierFull)
	}
	if state.Effective != TierMinimal {
		t.Fatalf("effective tier = %q, want hidden minimal", state.Effective)
	}
	if !state.Hidden {
		t.Fatalf("hidden = false, want true")
	}
}

func TestForcedTierLosesToHiddenPrecedence(t *testing.T) {
	m := NewWithAuto(0, TierDegraded)
	m.Step(Input{Force: forcePtr(ForceFull)}, 0)

	state := m.Step(Input{Hidden: boolPtr(true)}, time.Second)

	if state.Auto != TierDegraded {
		t.Fatalf("auto tier = %q, want %q", state.Auto, TierDegraded)
	}
	if state.Effective != TierMinimal {
		t.Fatalf("effective tier = %q, want hidden minimal", state.Effective)
	}
	assertForced(t, state, TierFull)
}

func TestForcedTierIsPerConnection(t *testing.T) {
	a := New(0)
	b := New(0)

	aState := a.Step(Input{Force: forcePtr(ForceMinimal)}, 0)
	bState := b.Step(Input{}, 0)

	assertState(t, aState, TierDegraded, TierMinimal)
	assertForced(t, aState, TierMinimal)
	assertState(t, bState, TierDegraded, TierDegraded)
	assertNoForced(t, bState)
}

func TestOverrideOffReturnsToAutomaticTier(t *testing.T) {
	m := NewWithAuto(0, TierDegraded)
	m.Step(Input{Force: forcePtr(ForceMinimal)}, 0)

	state := m.Step(Input{Force: forcePtr(ForceAuto)}, time.Second)

	assertState(t, state, TierDegraded, TierDegraded)
	assertNoForced(t, state)
}

func TestBackpressureDowngradesAndRestartsUpTimer(t *testing.T) {
	m := NewWithAuto(0, TierDegraded)
	m.Step(Input{Report: report(100, 10, 10)}, 0)
	m.Step(Input{Backpressure: 1200 * time.Millisecond}, 5*time.Second)

	state := m.Step(Input{Report: report(100, 10, 10)}, 10*time.Second)

	assertState(t, state, TierMinimal, TierMinimal)
}

func TestFreshReportRearmsMissingReportEpisode(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{}, 5*time.Second)

	afterFresh := m.Step(Input{Report: report(100, 10, 10)}, 6*time.Second)
	beforeNextDeadline := m.Step(Input{}, 10*time.Second)
	afterNextDeadline := m.Step(Input{}, 11*time.Second)

	assertState(t, afterFresh, TierDegraded, TierDegraded)
	assertState(t, beforeNextDeadline, TierDegraded, TierDegraded)
	assertState(t, afterNextDeadline, TierMinimal, TierMinimal)
}

func TestHiddenVisibleTransitionResetsReportEvidenceTimers(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(450, 20, 10)}, 0)
	m.Step(Input{Hidden: boolPtr(true)}, time.Second)
	m.Step(Input{Hidden: boolPtr(false)}, 2*time.Second)

	state := m.Step(Input{Report: report(450, 20, 10)}, 3*time.Second)

	assertState(t, state, TierFull, TierFull)
}

func TestHiddenVisibleTransitionRestartsMissingReportDeadline(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(100, 10, 10)}, 0)
	m.Step(Input{Hidden: boolPtr(true)}, time.Second)
	m.Step(Input{Hidden: boolPtr(false)}, 12*time.Second)

	state := m.Step(Input{}, 16*time.Second)

	assertState(t, state, TierFull, TierFull)
}

func TestForceAutoKeepsAutomaticBackpressureDowngrade(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Force: forcePtr(ForceFull)}, 0)
	m.Step(Input{Backpressure: 1200 * time.Millisecond}, time.Second)

	state := m.Step(Input{Force: forcePtr(ForceAuto)}, 2*time.Second)

	assertState(t, state, TierDegraded, TierDegraded)
	assertNoForced(t, state)
}

func TestInterleavedCandidatesTrackWorstConfirmedBoundary(t *testing.T) {
	m := NewWithAuto(0, TierFull)
	m.Step(Input{Report: report(450, 20, 10)}, 0)
	m.Step(Input{Report: report(1000, 180, 10)}, time.Second)

	state := m.Step(Input{Report: report(1000, 180, 10)}, 4*time.Second)

	assertState(t, state, TierMinimal, TierMinimal)
}

func TestTwoMachinesKeepIndependentAutomaticState(t *testing.T) {
	a := NewWithAuto(0, TierFull)
	b := NewWithAuto(0, TierFull)
	a.Step(Input{Report: report(1000, 180, 10)}, 0)
	b.Step(Input{Report: report(100, 10, 10)}, 0)

	aState := a.Step(Input{Report: report(1000, 180, 10)}, 3*time.Second)
	bState := b.Step(Input{}, 3*time.Second)

	assertState(t, aState, TierMinimal, TierMinimal)
	assertState(t, bState, TierFull, TierFull)
}

func report(latencyMS float64, jitterMS float64, samples int) *Report {
	return &Report{LatencyMS: latencyMS, JitterMS: jitterMS, Samples: samples}
}

func boolPtr(value bool) *bool {
	return &value
}

func forcePtr(value Force) *Force {
	return &value
}

func assertState(t *testing.T, state State, auto Tier, effective Tier) {
	t.Helper()
	if state.Auto != auto {
		t.Fatalf("auto tier = %q, want %q", state.Auto, auto)
	}
	if state.Effective != effective {
		t.Fatalf("effective tier = %q, want %q", state.Effective, effective)
	}
}

func assertFlush(t *testing.T, state State, want int) {
	t.Helper()
	if state.FlushMS != want {
		t.Fatalf("flush ms = %d, want %d", state.FlushMS, want)
	}
}

func assertForced(t *testing.T, state State, want Tier) {
	t.Helper()
	if state.Forced == nil {
		t.Fatalf("forced tier = nil, want %q", want)
	}
	if *state.Forced != want {
		t.Fatalf("forced tier = %q, want %q", *state.Forced, want)
	}
}

func assertNoForced(t *testing.T, state State) {
	t.Helper()
	if state.Forced != nil {
		t.Fatalf("forced tier = %q, want nil", *state.Forced)
	}
}

func assertReasonContains(t *testing.T, state State, want string) {
	t.Helper()
	if !strings.Contains(strings.ToLower(state.Reason), want) {
		t.Fatalf("reason = %q, want it to contain %q", state.Reason, want)
	}
}
