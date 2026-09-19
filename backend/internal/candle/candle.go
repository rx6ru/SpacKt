package candle

import "spackt/internal/model"

type Aggregator struct {
	intervalMS int64
	retention  int
	rev        uint64
	candles    []model.Candle
	start      int
	count      int
}

func New(intervalMS int64, retention int) *Aggregator {
	if intervalMS <= 0 {
		panic("candle: intervalMS must be positive")
	}
	if retention <= 0 {
		panic("candle: retention must be positive")
	}
	return &Aggregator{
		intervalMS: intervalMS,
		retention:  retention,
		candles:    make([]model.Candle, retention),
	}
}

func (a *Aggregator) Apply(trade model.Trade) []model.Candle {
	if trade.TimeMS < 0 {
		panic("candle: trade time must be non-negative")
	}
	if trade.PriceTicks <= 0 {
		panic("candle: trade price must be positive")
	}
	if trade.QuantityLots <= 0 {
		panic("candle: trade quantity must be positive")
	}

	start := bucketStart(trade.TimeMS, a.intervalMS)
	if a.count == 0 {
		return []model.Candle{a.appendReal(start, trade)}
	}

	last := a.last()
	if start < last.TimeMS {
		return nil
	}

	changed := a.advanceTo(start, false)
	last = a.last()
	if last.TimeMS == start {
		a.applyToActive(last, trade)
		changed = append(changed, *last)
		return retainLatest(changed, a.retention)
	}

	changed = append(changed, a.appendReal(start, trade))
	return retainLatest(changed, a.retention)
}

func (a *Aggregator) Advance(nowMS int64) []model.Candle {
	if nowMS < 0 {
		panic("candle: nowMS must be non-negative")
	}
	if a.count == 0 {
		return nil
	}
	return retainLatest(a.advanceTo(bucketStart(nowMS, a.intervalMS), true), a.retention)
}

func (a *Aggregator) History(limit int) []model.Candle {
	if limit <= 0 || a.count == 0 {
		return nil
	}
	if limit > a.count {
		limit = a.count
	}
	offset := a.count - limit
	history := make([]model.Candle, limit)
	for i := range history {
		history[i] = a.at(offset + i)
	}
	return history
}

func (a *Aggregator) advanceTo(targetStart int64, includeTarget bool) []model.Candle {
	last := a.last()
	if targetStart <= last.TimeMS {
		return nil
	}

	if !last.Closed {
		a.bump(last)
		last.Closed = true
	}

	firstNew := last.TimeMS + a.intervalMS
	lastNew := targetStart
	if !includeTarget {
		lastNew = targetStart - a.intervalMS
	}
	if lastNew < firstNew {
		return []model.Candle{*last}
	}

	totalNew := int((lastNew-firstNew)/a.intervalMS) + 1
	skip := 0
	if totalNew > a.retention {
		skip = totalNew - a.retention
	}

	changed := make([]model.Candle, 0, minInt(a.retention, totalNew+1))
	if skip == 0 {
		changed = append(changed, *last)
	}

	start := firstNew + int64(skip)*a.intervalMS
	for current := start; current <= lastNew; current += a.intervalMS {
		closed := current < targetStart || !includeTarget
		changed = append(changed, a.appendEmpty(current, closed))
	}
	return retainLatest(changed, a.retention)
}

func (a *Aggregator) appendReal(start int64, trade model.Trade) model.Candle {
	candle := model.Candle{
		TimeMS:     start,
		OpenTicks:  trade.PriceTicks,
		HighTicks:  trade.PriceTicks,
		LowTicks:   trade.PriceTicks,
		CloseTicks: trade.PriceTicks,
		VolumeLots: trade.QuantityLots,
	}
	a.bump(&candle)
	a.append(candle)
	return candle
}

func (a *Aggregator) appendEmpty(start int64, closed bool) model.Candle {
	closeTicks := a.last().CloseTicks
	candle := model.Candle{
		TimeMS:     start,
		OpenTicks:  closeTicks,
		HighTicks:  closeTicks,
		LowTicks:   closeTicks,
		CloseTicks: closeTicks,
		Closed:     closed,
	}
	a.bump(&candle)
	a.append(candle)
	return candle
}

func (a *Aggregator) applyToActive(candle *model.Candle, trade model.Trade) {
	if candle.VolumeLots == 0 {
		candle.OpenTicks = trade.PriceTicks
		candle.HighTicks = trade.PriceTicks
		candle.LowTicks = trade.PriceTicks
	} else {
		if trade.PriceTicks > candle.HighTicks {
			candle.HighTicks = trade.PriceTicks
		}
		if trade.PriceTicks < candle.LowTicks {
			candle.LowTicks = trade.PriceTicks
		}
	}
	candle.CloseTicks = trade.PriceTicks
	candle.VolumeLots += trade.QuantityLots
	candle.Closed = false
	a.bump(candle)
}

func (a *Aggregator) bump(candle *model.Candle) {
	a.rev++
	candle.Rev = a.rev
}

func (a *Aggregator) append(candle model.Candle) {
	if a.count < a.retention {
		a.candles[(a.start+a.count)%a.retention] = candle
		a.count++
		return
	}
	a.candles[a.start] = candle
	a.start = (a.start + 1) % a.retention
}

func (a *Aggregator) last() *model.Candle {
	return &a.candles[(a.start+a.count-1)%a.retention]
}

func (a *Aggregator) at(offset int) model.Candle {
	return a.candles[(a.start+offset)%a.retention]
}

func bucketStart(timeMS int64, intervalMS int64) int64 {
	return timeMS - timeMS%intervalMS
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func retainLatest(candles []model.Candle, limit int) []model.Candle {
	if len(candles) <= limit {
		return candles
	}
	return candles[len(candles)-limit:]
}
