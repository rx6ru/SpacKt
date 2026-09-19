package market

import "time"

type realClock struct {
	ticker *time.Ticker
}

func newRealClock(step time.Duration) *realClock {
	return &realClock{ticker: time.NewTicker(step)}
}

func (c *realClock) Now() time.Time {
	return time.Now()
}

func (c *realClock) Ticks() <-chan time.Time {
	return c.ticker.C
}

func (c *realClock) Stop() { c.ticker.Stop() }
