package delivery

import (
	"context"
	"errors"
	"spackt/internal/tier"
	"time"
)

const (
	controlSubscribe     = "subscribe"
	controlPing          = "ping"
	controlReport        = "report"
	controlInvalidReport = "invalid_report"
	controlVisibility    = "visibility"
	controlDebug         = "debug"
	controlError         = "error"

	debugForceTier         = "forceTier"
	debugDropNextBookDelta = "dropNextBookDelta"
	debugPongDelay         = "pongDelay"
	debugDisconnect        = "disconnect"
	errorDebugDisabled     = "debug_disabled"
	errorWrongSession      = "wrong_session"
	errorUnknownInterval   = "unknown_interval"
	errorBadRequestID      = "bad_request_id"
	errorBadMessage        = "bad_message"
	errorInternal          = "internal_error"
	closeNormal            = 1000
	closeAbnormalLocal     = 1006
	closeHiddenTimeout     = 4001
	closeDebugDisconnect   = 4003
	closeRateLimited       = 4008
	closePayloadTooLarge   = 4009
	writeDeadline          = 5 * time.Second
	controlTick            = 25 * time.Millisecond
	heartbeatEvery         = time.Second
	hiddenCloseAfter       = 180 * time.Second
	maxDelayedPongs        = 8
	errorEvery             = 10 * time.Second
	debugEvery             = time.Second
)

type Connection struct {
	connID         string
	source         StateSource
	sink           FrameSink
	options        ConnectionOptions
	session        *Session
	policy         *tier.Machine
	startedAt      time.Time
	lastPolicy     PolicyStatus
	havePolicy     bool
	nextFlush      time.Time
	nextHeartbeat  time.Time
	hiddenSince    time.Time
	pongDelay      time.Duration
	delayedPongs   []delayedPong
	dropNextBook   bool
	lastErrorAt    time.Time
	lastDebugAt    time.Time
	lastWriteClose CloseResult
}

type delayedPong struct {
	id  uint64
	due time.Time
}

func NewConnection(connID string, source StateSource, sink FrameSink, options ConnectionOptions) *Connection {
	return &Connection{
		connID:  connID,
		source:  source,
		sink:    sink,
		options: options,
		session: NewSession(connID, source, Options{}),
		policy:  tier.New(0),
	}
}

func (c *Connection) Run(ctx context.Context, events <-chan Control) CloseResult {
	c.startedAt = time.Now()
	now := c.startedAt
	state := c.stepPolicy(tier.Input{}, now)
	c.nextFlush = now.Add(time.Duration(state.FlushMS) * time.Millisecond)
	c.nextHeartbeat = now.Add(heartbeatEvery)

	if result, ok := c.writeHello(ctx, state); ok {
		return result
	}

	ticker := time.NewTicker(controlTick)
	defer ticker.Stop()

	for {
		if result, ok := c.drainControls(ctx, events); ok {
			return result
		}
		if result, ok := c.processDuePongs(ctx, time.Now()); ok {
			return result
		}

		select {
		case <-ctx.Done():
			return CloseResult{Code: closeNormal, Reason: "context closed"}
		case control, ok := <-events:
			if !ok {
				return CloseResult{Code: closeNormal, Reason: "control stream closed"}
			}
			if result, ok := c.handleControl(ctx, control, time.Now()); ok {
				return result
			}
		case <-ticker.C:
			now = time.Now()
			if result, ok := c.onTick(ctx, now); ok {
				return result
			}
		}
	}
}

func (c *Connection) drainControls(ctx context.Context, events <-chan Control) (CloseResult, bool) {
	for {
		select {
		case control, ok := <-events:
			if !ok {
				return CloseResult{Code: closeNormal, Reason: "control stream closed"}, true
			}
			if result, closeNow := c.handleControl(ctx, control, time.Now()); closeNow {
				return result, true
			}
		default:
			return CloseResult{}, false
		}
	}
}

func (c *Connection) onTick(ctx context.Context, now time.Time) (CloseResult, bool) {
	state := c.stepPolicy(tier.Input{}, now)
	if result, closeNow := c.maybeWritePolicy(ctx, state, now); closeNow {
		return result, true
	}
	if !c.hiddenSince.IsZero() && now.Sub(c.hiddenSince) >= hiddenCloseAfter {
		return CloseResult{Code: closeHiddenTimeout, Reason: "hidden timeout"}, true
	}
	if result, closeNow := c.processDuePongs(ctx, now); closeNow {
		return result, true
	}
	if !now.Before(c.nextHeartbeat) {
		if result, closeNow := c.writeHeartbeat(ctx); closeNow {
			return result, true
		}
		c.nextHeartbeat = now.Add(heartbeatEvery)
	}
	if !now.Before(c.nextFlush) {
		if result, closeNow := c.flushMarket(ctx); closeNow {
			return result, true
		}
		c.nextFlush = now.Add(time.Duration(c.lastPolicy.FlushMS) * time.Millisecond)
	}
	return CloseResult{}, false
}

func (c *Connection) handleControl(ctx context.Context, control Control, now time.Time) (CloseResult, bool) {
	if control.Session != "" && control.Session != c.sessionID() {
		return c.sendError(ctx, errorWrongSession, "message session does not match connection", now)
	}

	switch control.Kind {
	case controlSubscribe:
		return c.subscribe(ctx, control.subscribeCommand(), now)
	case controlPing:
		return c.pong(ctx, control.ID, now)
	case controlReport:
		state := c.stepPolicy(tier.Input{Report: &tier.Report{LatencyMS: control.LatencyMS, JitterMS: control.JitterMS, Samples: control.Samples}}, now)
		return c.maybeWritePolicy(ctx, state, now)
	case controlInvalidReport:
		state := c.stepPolicy(tier.Input{Report: &tier.Report{}}, now)
		return c.maybeWritePolicy(ctx, state, now)
	case controlVisibility:
		hidden := control.Hidden
		if hidden == c.lastPolicy.Hidden {
			return CloseResult{}, false
		}
		if hidden {
			c.hiddenSince = now
		} else {
			c.hiddenSince = time.Time{}
		}
		state := c.stepPolicy(tier.Input{Hidden: &hidden}, now)
		return c.writePolicy(ctx, state, now)
	case controlDebug:
		return c.debug(ctx, control, now)
	case controlError:
		code := control.ErrorCode
		if code == "" {
			code = errorBadMessage
		}
		return c.sendError(ctx, code, control.ErrorMessage, now)
	default:
		return c.sendError(ctx, errorBadMessage, "unknown control message", now)
	}
}

func (c *Connection) subscribe(ctx context.Context, command SubscribeCommand, now time.Time) (CloseResult, bool) {
	prepared, err := c.session.PrepareSubscribe(command)
	if err != nil {
		code := errorBadMessage
		if errors.Is(err, ErrUnknownInterval) {
			code = errorUnknownInterval
		}
		if errors.Is(err, ErrBadRequestID) {
			code = errorBadRequestID
		}
		return c.sendError(ctx, code, err.Error(), now)
	}
	return c.commit(ctx, prepared, false, now)
}

func (c *Connection) pong(ctx context.Context, id uint64, now time.Time) (CloseResult, bool) {
	if c.pongDelay <= 0 {
		return c.writeFrame(ctx, Frame{Session: c.sessionID(), Kind: FramePong, PongID: id}, now)
	}
	if len(c.delayedPongs) >= maxDelayedPongs {
		return CloseResult{Code: closeRateLimited, Reason: "too many delayed pongs"}, true
	}
	c.delayedPongs = append(c.delayedPongs, delayedPong{id: id, due: now.Add(c.pongDelay)})
	return CloseResult{}, false
}

func (c *Connection) processDuePongs(ctx context.Context, now time.Time) (CloseResult, bool) {
	kept := c.delayedPongs[:0]
	for _, pong := range c.delayedPongs {
		if now.Before(pong.due) {
			kept = append(kept, pong)
			continue
		}
		if result, closeNow := c.writeFrame(ctx, Frame{Session: c.sessionID(), Kind: FramePong, PongID: pong.id}, now); closeNow {
			c.delayedPongs = kept
			return result, true
		}
	}
	c.delayedPongs = kept
	return CloseResult{}, false
}

func (c *Connection) debug(ctx context.Context, control Control, now time.Time) (CloseResult, bool) {
	if !c.options.DebugControls {
		return c.sendError(ctx, errorDebugDisabled, "debug controls are disabled", now)
	}
	if !c.lastDebugAt.IsZero() && now.Sub(c.lastDebugAt) < debugEvery {
		return c.sendError(ctx, "rate_limited", "Wait one second between debug commands.", now)
	}
	c.lastDebugAt = now

	switch control.Action {
	case debugForceTier:
		force := tier.Force(control.Value)
		state := c.stepPolicy(tier.Input{Force: &force}, now)
		return c.maybeWritePolicy(ctx, state, now)
	case debugDropNextBookDelta:
		c.dropNextBook = true
		return CloseResult{}, false
	case debugPongDelay:
		if control.DelayMS > 4000 {
			control.DelayMS = 4000
		}
		if control.DelayMS < 0 {
			control.DelayMS = 0
		}
		c.pongDelay = time.Duration(control.DelayMS) * time.Millisecond
		return CloseResult{}, false
	case debugDisconnect:
		return CloseResult{Code: closeDebugDisconnect, Reason: "debug disconnect"}, true
	default:
		return c.sendError(ctx, errorBadMessage, "unknown debug action", now)
	}
}

func (c *Connection) flushMarket(ctx context.Context) (CloseResult, bool) {
	prepared := c.session.PrepareFlush(time.Now().UnixMilli())
	return c.commit(ctx, prepared, c.dropNextBook, time.Now())
}

func (c *Connection) commit(ctx context.Context, prepared PreparedFlush, dropBook bool, now time.Time) (CloseResult, bool) {
	if len(prepared.Frames()) == 0 {
		return CloseResult{}, false
	}
	var marketDuration time.Duration
	dropped := false
	sink := connectionSink{connection: c, dropBook: dropBook, dropped: &dropped, marketDuration: &marketDuration}
	_, err := prepared.Commit(ctx, sink)
	if dropped && err == nil {
		c.dropNextBook = false
	}
	if err != nil {
		return c.closeForWriteError(err), true
	}
	if marketDuration > time.Second {
		state := c.stepPolicy(tier.Input{Backpressure: marketDuration}, time.Now())
		return c.maybeWritePolicy(ctx, state, now)
	}
	return CloseResult{}, false
}

func (c *Connection) writeHello(ctx context.Context, state tier.State) (CloseResult, bool) {
	frame := Frame{
		Session: c.sessionID(),
		Kind:    FrameHello,
		ConnID:  c.connID,
		Policy:  policyStatus(state),
	}
	result, closeNow := c.writeFrame(ctx, frame, time.Now())
	if closeNow {
		return result, true
	}
	c.lastPolicy = *frame.Policy
	c.havePolicy = true
	return CloseResult{}, false
}

func (c *Connection) writeHeartbeat(ctx context.Context) (CloseResult, bool) {
	pub := c.source.Current()
	cursor := c.session.Cursors()
	var requestID *uint64
	var latestRev *uint64
	if cursor.CandleRequestID != 0 {
		id := cursor.CandleRequestID
		requestID = &id
		candles := pub.Candles[cursor.CandleInterval]
		if len(candles) != 0 {
			rev := candles[len(candles)-1].Rev
			latestRev = &rev
		}
	}
	feedReady := true
	if c.options.FeedReady != nil {
		feedReady = c.options.FeedReady()
	}
	return c.writeFrame(ctx, Frame{
		Session: c.sessionID(),
		Kind:    FrameHeartbeat,
		Heartbeat: &Heartbeat{
			MarketRev:       pub.MarketRev,
			BookSeq:         pub.Book.Seq,
			CandleRequestID: requestID,
			CandleLatestRev: latestRev,
			FeedReady:       feedReady,
		},
	}, time.Now())
}

func (c *Connection) writePolicy(ctx context.Context, state tier.State, now time.Time) (CloseResult, bool) {
	status := policyStatus(state)
	result, closeNow := c.writeFrame(ctx, Frame{Session: c.sessionID(), Kind: FrameTier, Policy: status}, now)
	if closeNow {
		return result, true
	}
	c.lastPolicy = *status
	c.havePolicy = true
	c.nextFlush = time.Now().Add(time.Duration(status.FlushMS) * time.Millisecond)
	return CloseResult{}, false
}

func (c *Connection) maybeWritePolicy(ctx context.Context, state tier.State, now time.Time) (CloseResult, bool) {
	status := policyStatus(state)
	if c.havePolicy && samePolicy(c.lastPolicy, *status) {
		return CloseResult{}, false
	}
	return c.writePolicy(ctx, state, now)
}

func (c *Connection) sendError(ctx context.Context, code string, message string, now time.Time) (CloseResult, bool) {
	if message == "" {
		message = code
	}
	if !c.lastErrorAt.IsZero() && now.Sub(c.lastErrorAt) < errorEvery {
		return CloseResult{}, false
	}
	c.lastErrorAt = now
	return c.writeFrame(ctx, Frame{Session: c.sessionID(), Kind: FrameError, Error: &Error{Code: code, Message: message}}, now)
}

func (c *Connection) writeFrame(ctx context.Context, frame Frame, now time.Time) (CloseResult, bool) {
	frame.Session = c.sessionID()
	ctx, cancel := context.WithTimeout(ctx, writeDeadline)
	defer cancel()
	_, err := c.sink.Write(ctx, frame)
	if err != nil {
		return c.closeForWriteError(err), true
	}
	return CloseResult{}, false
}

func (c *Connection) closeForWriteError(err error) CloseResult {
	if errors.Is(err, ErrPayloadTooLarge) {
		return CloseResult{Code: closePayloadTooLarge, Reason: "payload too large"}
	}
	return CloseResult{Code: closeAbnormalLocal, Reason: "write failed"}
}

func (c *Connection) stepPolicy(input tier.Input, now time.Time) tier.State {
	return c.policy.Step(input, now.Sub(c.startedAt))
}

func (c *Connection) sessionID() string {
	return c.source.Current().Session
}

type connectionSink struct {
	connection     *Connection
	dropBook       bool
	dropped        *bool
	marketDuration *time.Duration
}

func (s connectionSink) Write(ctx context.Context, frame Frame) (time.Duration, error) {
	if s.dropBook && frame.Kind == FrameUpdate && frame.Book != nil {
		frame.Book = nil
		*s.dropped = true
		if frame.Candles == nil && len(frame.Trades) == 0 {
			return 0, nil
		}
	}
	ctx, cancel := context.WithTimeout(ctx, writeDeadline)
	defer cancel()
	duration, err := s.connection.sink.Write(ctx, frame)
	if err == nil && frame.Kind == FrameUpdate {
		*s.marketDuration += duration
	}
	return duration, err
}

func policyStatus(state tier.State) *PolicyStatus {
	if state.Reason == "" {
		switch {
		case state.Hidden:
			state.Reason = "Hidden tab"
		case state.Forced != nil:
			state.Reason = "Forced by viewer"
		default:
			state.Reason = "Automatic policy"
		}
	}
	var forced *string
	if state.Forced != nil {
		value := string(*state.Forced)
		forced = &value
	}
	return &PolicyStatus{
		Effective: string(state.Effective),
		Auto:      string(state.Auto),
		Forced:    forced,
		Hidden:    state.Hidden,
		FlushMS:   state.FlushMS,
		Reason:    state.Reason,
	}
}

func samePolicy(left PolicyStatus, right PolicyStatus) bool {
	if left.Effective != right.Effective || left.Auto != right.Auto || left.Hidden != right.Hidden || left.FlushMS != right.FlushMS || left.Reason != right.Reason {
		return false
	}
	if left.Forced == nil || right.Forced == nil {
		return left.Forced == nil && right.Forced == nil
	}
	return *left.Forced == *right.Forced
}
