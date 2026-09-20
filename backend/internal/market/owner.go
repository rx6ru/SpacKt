package market

import (
	"context"
	"errors"
	"spackt/internal/candle"
	"spackt/internal/model"
	"spackt/internal/sim"
	"sync"
	"time"
)

type Clock interface {
	Now() time.Time
	Ticks() <-chan time.Time
}

type eventSource interface {
	Next() sim.Event
}

type Config struct {
	Session        string
	Symbol         string
	Seed           int64
	EpochMS        int64
	HistoryMinutes int
	Step           time.Duration
	Retention      Retention
}

type Retention struct {
	HistoryCandles           map[model.CandleInterval]int
	DeliveryClosedCandles    int
	RecentTrades             int
	BookChanges              int
	MaximumBookLevelsPerSide int
}

type Publication = model.Publication

type BookCapture = model.BookCapture

type Owner struct {
	cfg        Config
	clk        Clock
	sim        eventSource
	aggs       map[model.CandleInterval]*candle.Aggregator
	revs       map[candleKey]uint64
	reqs       chan captureRequest
	done       chan struct{}
	stop       context.CancelFunc
	stopClock  func()
	finishOnce sync.Once
	state      ownerState
	mu         sync.RWMutex
}

type ownerState struct {
	current     model.Publication
	workRev     uint64
	workTimeMS  int64
	workBook    model.BookSnapshot
	lastPublish time.Time
	running     bool
	closed      bool
	initialized bool
	bookChanges []model.LevelChange
	trades      []model.Trade
	lastTradeID uint64
	latestPrice int64
	reference   int64
}

type candleKey struct {
	interval model.CandleInterval
	timeMS   int64
}

type captureKind int

const (
	captureBook captureKind = iota
	captureHistory
	captureTrades
)

type captureRequest struct {
	kind     captureKind
	interval model.CandleInterval
	limit    int
	resp     chan captureResponse
}

type captureResponse struct {
	book    model.BookCapture
	candles []model.Candle
	trades  []model.Trade
	err     error
}

var errOwnerClosed = errors.New("market owner closed")
var errCaptureBusy = errors.New("market capture busy")

const (
	defaultSession        = "session-1"
	defaultSymbol         = "BTC-USD"
	defaultEpochMS        = int64(1700000000000)
	defaultHistoryMinutes = 360
	defaultStep           = 100 * time.Millisecond
	captureQueueSize      = 32
	captureDeadline       = 2 * time.Second
	maxCapturesPerStep    = 8
	readinessWindow       = 2 * time.Second
	defaultMidTicks       = int64(6400000)
)

func DefaultConfig() Config {
	return Config{
		Session:        defaultSession,
		Symbol:         defaultSymbol,
		EpochMS:        defaultEpochMS,
		HistoryMinutes: defaultHistoryMinutes,
		Step:           defaultStep,
		Retention: Retention{
			HistoryCandles: map[model.CandleInterval]int{
				model.Interval1s: 3600,
				model.Interval1m: 1440,
				model.Interval5m: 2016,
			},
			DeliveryClosedCandles:    64,
			RecentTrades:             200,
			BookChanges:              4096,
			MaximumBookLevelsPerSide: 50,
		},
	}
}

func NewOwner(cfg Config, clk Clock) (*Owner, error) {
	cfg = normalizeConfig(cfg)
	var stopClock func()
	if clk == nil {
		real := newRealClock(cfg.Step)
		clk = real
		stopClock = real.Stop
	}
	return &Owner{
		cfg:       cfg,
		stopClock: stopClock,
		clk:       clk,
		sim:       sim.New(sim.Config{Seed: cfg.Seed, EpochMS: cfg.EpochMS, MidTicks: defaultMidTicks, StepMS: int64(cfg.Step / time.Millisecond)}),
		aggs:      newAggregators(cfg.Retention.HistoryCandles),
		revs:      make(map[candleKey]uint64),
		reqs:      make(chan captureRequest, captureQueueSize),
		done:      make(chan struct{}),
	}, nil
}

func (o *Owner) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	o.mu.Lock()
	if o.state.running {
		o.mu.Unlock()
		return errors.New("market owner already started")
	}
	if o.state.closed {
		o.mu.Unlock()
		return errOwnerClosed
	}
	runCtx, cancel := context.WithCancel(ctx)
	o.stop = cancel
	o.state.running = true
	o.mu.Unlock()

	scheduled := o.clk.Now()
	warmupSteps := int((time.Duration(o.cfg.HistoryMinutes) * time.Minute) / o.cfg.Step)
	for i := 0; i < warmupSteps; i++ {
		if err := runCtx.Err(); err != nil {
			o.finish()
			return err
		}
		o.applyEvent(o.sim.Next())
	}
	if err := runCtx.Err(); err != nil {
		o.finish()
		return err
	}
	o.cleanupCandleRevisions()
	o.publish(o.clk.Now())
	go o.run(runCtx, scheduled)
	return nil
}

func (o *Owner) Close(ctx context.Context) error {
	o.mu.Lock()
	o.state.closed = true
	o.state.running = false
	cancel := o.stop
	o.mu.Unlock()
	if cancel == nil {
		o.finish()
	} else {
		cancel()
	}
	select {
	case <-o.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (o *Owner) finish() {
	o.finishOnce.Do(func() {
		o.mu.Lock()
		o.state.running = false
		o.state.closed = true
		o.mu.Unlock()
		if o.stopClock != nil {
			o.stopClock()
		}
		o.failPendingCaptures(errOwnerClosed)
		close(o.done)
	})
}

func (o *Owner) Ready() bool {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return o.state.running &&
		!o.state.closed &&
		o.state.initialized &&
		o.state.current.Session != "" &&
		o.clk.Now().Sub(o.state.lastPublish) <= readinessWindow
}

func (o *Owner) Current() model.Publication {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return clonePublication(o.state.current)
}

func (o *Owner) CaptureBook(ctx context.Context) (BookCapture, error) {
	response, err := o.capture(ctx, captureRequest{kind: captureBook})
	if err != nil {
		return BookCapture{}, err
	}
	return response.book, response.err
}

func (o *Owner) CaptureHistory(ctx context.Context, interval model.CandleInterval, limit int) ([]model.Candle, error) {
	response, err := o.capture(ctx, captureRequest{kind: captureHistory, interval: interval, limit: limit})
	if err != nil {
		return nil, err
	}
	return response.candles, response.err
}

func (o *Owner) CaptureTrades(ctx context.Context, limit int) ([]model.Trade, error) {
	response, err := o.capture(ctx, captureRequest{kind: captureTrades, limit: limit})
	if err != nil {
		return nil, err
	}
	return response.trades, response.err
}

func (o *Owner) run(ctx context.Context, scheduled time.Time) {
	defer o.finish()
	captures := 0
	advance := func(at time.Time) bool {
		due := int(at.Sub(scheduled) / o.cfg.Step)
		if due <= 0 {
			return true
		}
		for i := 0; i < due; i++ {
			if ctx.Err() != nil {
				return false
			}
			o.applyEvent(o.sim.Next())
		}
		scheduled = scheduled.Add(time.Duration(due) * o.cfg.Step)
		o.publish(o.clk.Now())
		return true
	}
	for {
		if ctx.Err() != nil {
			return
		}
		// After eight captures, wait for clock work instead of accepting a ninth.
		if captures >= maxCapturesPerStep {
			select {
			case <-ctx.Done():
				return
			case at, ok := <-o.clk.Ticks():
				if !ok || !advance(at) {
					return
				}
				captures = 0
			}
			continue
		}
		select {
		case <-ctx.Done():
			return
		case at, ok := <-o.clk.Ticks():
			if !ok || !advance(at) {
				return
			}
			captures = 0
		case req := <-o.reqs:
			o.handleCapture(req)
			captures++
		}
	}
}

func (o *Owner) capture(ctx context.Context, req captureRequest) (captureResponse, error) {
	if err := ctx.Err(); err != nil {
		return captureResponse{}, err
	}
	o.mu.RLock()
	closed := o.state.closed
	o.mu.RUnlock()
	if closed {
		return captureResponse{}, errOwnerClosed
	}

	ctx, cancel := context.WithTimeout(ctx, captureDeadline)
	defer cancel()
	req.resp = make(chan captureResponse, 1)
	select {
	case o.reqs <- req:
	case <-ctx.Done():
		return captureResponse{}, ctx.Err()
	default:
		return captureResponse{}, errCaptureBusy
	}

	select {
	case response := <-req.resp:
		return response, nil
	case <-ctx.Done():
		return captureResponse{}, ctx.Err()
	}
}

func (o *Owner) failPendingCaptures(err error) {
	for {
		select {
		case req := <-o.reqs:
			o.respond(req, captureResponse{err: err})
		default:
			return
		}
	}
}

func (o *Owner) handleCapture(req captureRequest) {
	var response captureResponse
	switch req.kind {
	case captureBook:
		current := o.Current()
		response.book = model.BookCapture{
			Session: current.Session,
			Symbol:  current.Symbol,
			TimeMS:  current.TimeMS,
			Book:    cloneBook(current.Book),
		}
	case captureHistory:
		agg := o.aggs[req.interval]
		if agg == nil {
			response.err = errors.New("unknown candle interval")
			break
		}
		limit := req.limit
		if max := o.cfg.Retention.HistoryCandles[req.interval]; limit <= 0 || limit > max {
			limit = max
		}
		response.candles = o.normalizeCandles(req.interval, agg.History(limit))
	case captureTrades:
		response.trades = cloneTrades(tailTrades(o.state.trades, req.limit))
	}
	o.respond(req, response)
}

func (o *Owner) respond(req captureRequest, response captureResponse) {
	select {
	case req.resp <- response:
	default:
	}
}

func (o *Owner) applyEvent(event sim.Event) {
	o.mu.Lock()
	defer o.mu.Unlock()

	if len(event.Trades) > 0 {
		o.state.trades = append(o.state.trades, event.Trades...)
		o.state.trades = tailTrades(o.state.trades, o.cfg.Retention.RecentTrades)
		for _, trade := range event.Trades {
			o.state.lastTradeID = trade.ID
			o.state.latestPrice = trade.PriceTicks
			if !o.state.initialized {
				o.state.reference = trade.PriceTicks
			}
			for interval, agg := range o.aggs {
				o.recordCandles(interval, agg.Apply(trade), event.Rev)
			}
		}
	}
	for interval, agg := range o.aggs {
		o.recordCandles(interval, agg.Advance(event.TimeMS), event.Rev)
	}
	o.state.bookChanges = append(o.state.bookChanges, event.BookChanges...)
	o.state.bookChanges = tailLevelChanges(o.state.bookChanges, o.cfg.Retention.BookChanges)
	o.state.workTimeMS = event.TimeMS
	o.state.workRev = event.Rev
	o.state.workBook = event.Book
}

func (o *Owner) publish(at time.Time) {
	current := model.Publication{
		Session:             o.cfg.Session,
		Symbol:              o.cfg.Symbol,
		MarketRev:           o.state.workRev,
		TimeMS:              o.state.workTimeMS,
		Book:                cloneBookDepth(o.state.workBook, o.cfg.Retention.MaximumBookLevelsPerSide),
		BookChanges:         cloneLevelChanges(tailLevelChanges(o.state.bookChanges, o.cfg.Retention.BookChanges)),
		Candles:             o.deliveryCandles(),
		Trades:              cloneTrades(tailTrades(o.state.trades, o.cfg.Retention.RecentTrades)),
		LastTradeID:         o.state.lastTradeID,
		LatestPriceTicks:    o.state.latestPrice,
		ReferencePriceTicks: o.state.reference,
	}
	o.mu.Lock()
	if o.state.closed {
		o.mu.Unlock()
		return
	}
	o.state.current = current
	o.state.lastPublish = at
	o.state.initialized = true
	o.mu.Unlock()
}

func (o *Owner) deliveryCandles() map[model.CandleInterval][]model.Candle {
	out := make(map[model.CandleInterval][]model.Candle, len(o.aggs))
	limit := o.cfg.Retention.DeliveryClosedCandles + 1
	for interval, agg := range o.aggs {
		out[interval] = o.normalizeCandles(interval, agg.History(limit))
	}
	return out
}

func (o *Owner) recordCandles(interval model.CandleInterval, candles []model.Candle, rev uint64) {
	for _, candle := range candles {
		o.revs[candleKey{interval: interval, timeMS: candle.TimeMS}] = rev
		span := map[model.CandleInterval]int64{model.Interval1s: 1000, model.Interval1m: 60000, model.Interval5m: 300000}[interval]
		oldest := candle.TimeMS - int64(o.cfg.Retention.HistoryCandles[interval])*span
		delete(o.revs, candleKey{interval: interval, timeMS: oldest})
	}
}

func (o *Owner) normalizeCandles(interval model.CandleInterval, candles []model.Candle) []model.Candle {
	out := cloneCandles(candles)
	for i := range out {
		if rev := o.revs[candleKey{interval: interval, timeMS: out[i].TimeMS}]; rev != 0 {
			out[i].Rev = rev
		}
	}
	return out
}

func (o *Owner) cleanupCandleRevisions() {
	keep := make(map[candleKey]struct{})
	for interval, agg := range o.aggs {
		for _, candle := range agg.History(o.cfg.Retention.HistoryCandles[interval]) {
			keep[candleKey{interval: interval, timeMS: candle.TimeMS}] = struct{}{}
		}
	}
	for key := range o.revs {
		if _, ok := keep[key]; !ok {
			delete(o.revs, key)
		}
	}
}

func normalizeConfig(cfg Config) Config {
	def := DefaultConfig()
	if cfg.Session == "" {
		cfg.Session = def.Session
	}
	if cfg.Symbol == "" {
		cfg.Symbol = def.Symbol
	}
	if cfg.EpochMS == 0 {
		cfg.EpochMS = def.EpochMS
	}
	if cfg.HistoryMinutes <= 0 {
		cfg.HistoryMinutes = def.HistoryMinutes
	}
	if cfg.Step <= 0 {
		cfg.Step = def.Step
	}
	if cfg.Retention.HistoryCandles == nil {
		cfg.Retention.HistoryCandles = def.Retention.HistoryCandles
	}
	cfg.Retention.HistoryCandles = normalizeHistoryRetention(cfg.Retention.HistoryCandles)
	if cfg.Retention.DeliveryClosedCandles <= 0 {
		cfg.Retention.DeliveryClosedCandles = def.Retention.DeliveryClosedCandles
	}
	if cfg.Retention.RecentTrades <= 0 {
		cfg.Retention.RecentTrades = def.Retention.RecentTrades
	}
	if cfg.Retention.BookChanges <= 0 {
		cfg.Retention.BookChanges = def.Retention.BookChanges
	}
	if cfg.Retention.MaximumBookLevelsPerSide <= 0 {
		cfg.Retention.MaximumBookLevelsPerSide = def.Retention.MaximumBookLevelsPerSide
	}
	return cfg
}

func normalizeHistoryRetention(in map[model.CandleInterval]int) map[model.CandleInterval]int {
	def := DefaultConfig().Retention.HistoryCandles
	out := make(map[model.CandleInterval]int, len(def))
	for interval, value := range def {
		out[interval] = value
	}
	for interval, value := range in {
		if value > 0 {
			out[interval] = value
		}
	}
	return out
}

func newAggregators(retention map[model.CandleInterval]int) map[model.CandleInterval]*candle.Aggregator {
	return map[model.CandleInterval]*candle.Aggregator{
		model.Interval1s: candle.New(1000, retention[model.Interval1s]),
		model.Interval1m: candle.New(60_000, retention[model.Interval1m]),
		model.Interval5m: candle.New(300_000, retention[model.Interval5m]),
	}
}

func clonePublication(pub model.Publication) model.Publication {
	pub.Book = cloneBook(pub.Book)
	pub.BookChanges = cloneLevelChanges(pub.BookChanges)
	pub.Candles = cloneCandleMap(pub.Candles)
	pub.Trades = cloneTrades(pub.Trades)
	return pub
}

func cloneBookDepth(book model.BookSnapshot, depth int) model.BookSnapshot {
	book = cloneBook(book)
	if depth > 0 && len(book.Bids) > depth {
		book.Bids = book.Bids[:depth]
	}
	if depth > 0 && len(book.Asks) > depth {
		book.Asks = book.Asks[:depth]
	}
	return book
}

func cloneBook(book model.BookSnapshot) model.BookSnapshot {
	return model.BookSnapshot{
		Seq:  book.Seq,
		Bids: cloneLevels(book.Bids),
		Asks: cloneLevels(book.Asks),
	}
}

func cloneLevels(levels []model.Level) []model.Level {
	out := make([]model.Level, len(levels))
	copy(out, levels)
	return out
}

func cloneLevelChanges(changes []model.LevelChange) []model.LevelChange {
	out := make([]model.LevelChange, len(changes))
	copy(out, changes)
	return out
}

func cloneTrades(trades []model.Trade) []model.Trade {
	out := make([]model.Trade, len(trades))
	copy(out, trades)
	return out
}

func cloneCandles(candles []model.Candle) []model.Candle {
	out := make([]model.Candle, len(candles))
	copy(out, candles)
	return out
}

func cloneCandleMap(candles map[model.CandleInterval][]model.Candle) map[model.CandleInterval][]model.Candle {
	out := make(map[model.CandleInterval][]model.Candle, len(candles))
	for interval, values := range candles {
		out[interval] = cloneCandles(values)
	}
	return out
}

func tailTrades(trades []model.Trade, limit int) []model.Trade {
	if limit <= 0 || len(trades) <= limit {
		return trades
	}
	return trades[len(trades)-limit:]
}

func tailLevelChanges(changes []model.LevelChange, limit int) []model.LevelChange {
	if limit <= 0 || len(changes) <= limit {
		return changes
	}
	return changes[len(changes)-limit:]
}
