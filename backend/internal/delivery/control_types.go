package delivery

import "spackt/internal/model"

type Control struct {
	Kind         string
	Session      string
	ID           uint64
	Subscription SubscribeCommand
	LatencyMS    float64
	JitterMS     float64
	Samples      int
	Hidden       bool
	Action       string
	Value        string
	DelayMS      int
	ErrorCode    string
	ErrorMessage string
}

type ConnectionOptions struct {
	DebugControls bool
	FeedReady     func() bool
}

type CloseResult struct {
	Code   int
	Reason string
}

func (c Control) subscribeCommand() SubscribeCommand {
	if c.Subscription.Interval != "" || c.Subscription.RequestID != 0 {
		return c.Subscription
	}
	return SubscribeCommand{Interval: model.CandleInterval(c.Value), RequestID: c.ID}
}
