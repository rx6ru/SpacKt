package tier

import (
	"math"
	"time"
)

type Tier string

const (
	TierFull     Tier = "full"
	TierDegraded Tier = "degraded"
	TierMinimal  Tier = "minimal"
)

type Force string

const (
	ForceAuto     Force = "auto"
	ForceFull     Force = "full"
	ForceDegraded Force = "degraded"
	ForceMinimal  Force = "minimal"
)

type Report struct {
	LatencyMS float64
	JitterMS  float64
	Samples   int
}

type Input struct {
	Report       *Report
	Hidden       *bool
	Force        *Force
	Backpressure time.Duration
}

type State struct {
	Auto      Tier
	Effective Tier
	Forced    *Tier
	Hidden    bool
	FlushMS   int
	Reason    string
}

type Machine struct {
	auto   Tier
	forced *Tier
	hidden bool

	lastVisibleReport time.Duration
	missingDowngraded bool

	degradedBadSince *time.Duration
	minimalBadSince  *time.Duration
	upGoodSince      *time.Duration
}

func New(now time.Duration) *Machine {
	return NewWithAuto(now, TierDegraded)
}

func NewWithAuto(now time.Duration, initial Tier) *Machine {
	if !validTier(initial) {
		initial = TierDegraded
	}
	return &Machine{
		auto:              initial,
		lastVisibleReport: now,
	}
}

func (m *Machine) Step(input Input, now time.Duration) State {
	reason := ""

	if input.Hidden != nil && *input.Hidden != m.hidden {
		m.hidden = *input.Hidden
		m.resetEvidence()
		if !m.hidden {
			m.lastVisibleReport = now
			m.missingDowngraded = false
		}
	}

	if input.Force != nil {
		m.applyForce(*input.Force)
	}

	if input.Backpressure > time.Second {
		if downgraded, changed := downgrade(m.auto); changed {
			m.auto = downgraded
			reason = "backpressure downgraded to " + string(m.auto)
		}
		m.upGoodSince = nil
	}

	validVisibleReport := input.Report != nil && validReport(*input.Report)
	if input.Report != nil && !validVisibleReport {
		m.resetEvidence()
	}
	if validVisibleReport {
		if !m.hidden {
			m.lastVisibleReport = now
			m.missingDowngraded = false
		}
		if r := m.applyReport(*input.Report, now); r != "" {
			reason = r
		}
	}

	if !m.hidden && !validVisibleReport {
		if r := m.applyMissingReport(now); r != "" {
			reason = r
		}
	}

	return m.state(reason)
}

func (m *Machine) applyForce(force Force) {
	switch force {
	case ForceAuto:
		m.forced = nil
	case ForceFull:
		m.setForced(TierFull)
	case ForceDegraded:
		m.setForced(TierDegraded)
	case ForceMinimal:
		m.setForced(TierMinimal)
	}
}

func (m *Machine) setForced(tier Tier) {
	value := tier
	m.forced = &value
}

func (m *Machine) applyReport(report Report, now time.Duration) string {
	degradedBad := report.LatencyMS > 400 || report.JitterMS > 60
	minimalBad := report.LatencyMS > 900 || report.JitterMS > 150

	updateTimer(&m.degradedBadSince, degradedBad, now)
	updateTimer(&m.minimalBadSince, minimalBad, now)

	upGood := upwardGood(m.auto, report)
	updateTimer(&m.upGoodSince, upGood, now)

	if confirmed(m.minimalBadSince, now, 3*time.Second) && m.auto != TierMinimal {
		m.auto = TierMinimal
		m.resetEvidence()
		return "automatic tier minimal after confirmed report"
	}

	if confirmed(m.degradedBadSince, now, 3*time.Second) && m.auto == TierFull {
		m.auto = TierDegraded
		m.resetEvidence()
		return "automatic tier degraded after confirmed report"
	}

	if confirmed(m.upGoodSince, now, 10*time.Second) {
		if upgraded, changed := upgrade(m.auto); changed {
			m.auto = upgraded
			m.resetEvidence()
			return "automatic tier recovered to " + string(m.auto)
		}
		m.upGoodSince = nil
	}

	return ""
}

func (m *Machine) applyMissingReport(now time.Duration) string {
	since := now - m.lastVisibleReport
	if since >= 12*time.Second {
		m.resetEvidence()
		m.missingDowngraded = true
		if m.auto != TierMinimal {
			m.auto = TierMinimal
			return "missing reports set automatic tier minimal"
		}
		return ""
	}

	if since >= 5*time.Second && !m.missingDowngraded {
		m.resetEvidence()
		m.missingDowngraded = true
		if downgraded, changed := downgrade(m.auto); changed {
			m.auto = downgraded
			return "missing reports downgraded automatic tier to " + string(m.auto)
		}
	}

	return ""
}

func (m *Machine) resetEvidence() {
	m.degradedBadSince = nil
	m.minimalBadSince = nil
	m.upGoodSince = nil
}

func (m *Machine) state(reason string) State {
	effective := m.auto
	if m.forced != nil {
		effective = *m.forced
	}
	if m.hidden {
		effective = TierMinimal
	}

	var forced *Tier
	if m.forced != nil {
		value := *m.forced
		forced = &value
	}

	return State{
		Auto:      m.auto,
		Effective: effective,
		Forced:    forced,
		Hidden:    m.hidden,
		FlushMS:   flushMS(effective),
		Reason:    reason,
	}
}

func updateTimer(timer **time.Duration, qualifies bool, now time.Duration) {
	if !qualifies {
		*timer = nil
		return
	}
	if *timer == nil {
		start := now
		*timer = &start
	}
}

func confirmed(since *time.Duration, now time.Duration, dwell time.Duration) bool {
	return since != nil && now-*since >= dwell
}

func upwardGood(auto Tier, report Report) bool {
	switch auto {
	case TierMinimal:
		return report.LatencyMS < 700 && report.JitterMS < 100
	case TierDegraded:
		return report.LatencyMS < 300 && report.JitterMS < 40
	default:
		return false
	}
}

func upgrade(tier Tier) (Tier, bool) {
	switch tier {
	case TierMinimal:
		return TierDegraded, true
	case TierDegraded:
		return TierFull, true
	default:
		return tier, false
	}
}

func downgrade(tier Tier) (Tier, bool) {
	switch tier {
	case TierFull:
		return TierDegraded, true
	case TierDegraded:
		return TierMinimal, true
	default:
		return tier, false
	}
}

func flushMS(tier Tier) int {
	switch tier {
	case TierFull:
		return 100
	case TierMinimal:
		return 2000
	default:
		return 500
	}
}

func validReport(report Report) bool {
	return validMeasurement(report.LatencyMS) &&
		validMeasurement(report.JitterMS) &&
		report.Samples >= 2 &&
		report.Samples <= 10
}

func validMeasurement(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 60000
}

func validTier(tier Tier) bool {
	return tier == TierFull || tier == TierDegraded || tier == TierMinimal
}
