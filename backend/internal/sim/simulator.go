package sim

import (
	"errors"
	"math/rand/v2"

	"spackt/internal/matching"
	"spackt/internal/model"
)

type Config struct {
	Seed     int64
	EpochMS  int64
	MidTicks int64
	StepMS   int64
}

type Event struct {
	Rev         uint64
	TimeMS      int64
	Trades      []model.Trade
	BookChanges []model.LevelChange
	Book        model.BookSnapshot
}

type Simulator struct {
	rng         *rand.Rand
	engine      *matching.Engine
	epochMS     int64
	stepMS      int64
	nextIndex   int64
	rev         uint64
	nextTrade   uint64
	seedChanges []model.LevelChange
}

const (
	defaultMidTicks   = int64(6400000)
	defaultStepMS     = int64(100)
	minPriceTicks     = int64(10000)
	maxPriceTicks     = int64(10000000)
	maxTradeLots      = int64(10000)
	maxBookLots       = int64(100000)
	matchingOrderCap  = 1024
	targetDepth       = 20
	maxDepth          = 50
	maxSpreadTicks    = int64(20)
	quoteRadiusTicks  = int64(10)
	maintenanceBudget = 2132
)

func New(config Config) *Simulator {
	if config.MidTicks == 0 {
		config.MidTicks = defaultMidTicks
	}
	config.MidTicks = clampMidTicks(config.MidTicks)
	if config.StepMS == 0 {
		config.StepMS = defaultStepMS
	}
	engine, err := matching.New(matching.Limits{
		MinPriceTicks: minPriceTicks,
		MaxPriceTicks: maxPriceTicks,
		MaxOrderLots:  maxBookLots,
		MaxLevelLots:  maxBookLots,
		MaxOrders:     matchingOrderCap,
	})
	if err != nil {
		panic("simulator matching limits are invalid")
	}
	s := &Simulator{
		rng:       rand.New(rand.NewPCG(uint64(config.Seed), uint64(config.Seed)^0x9e3779b97f4a7c15)),
		engine:    engine,
		epochMS:   config.EpochMS,
		stepMS:    config.StepMS,
		nextTrade: 1,
	}
	s.seedChanges = s.seedBook(config.MidTicks)
	return s
}

func (s *Simulator) Next() Event {
	eventTime := s.epochMS + s.nextIndex*s.stepMS
	s.nextIndex++
	anchorMid := bookMidpoint(s.engine.Snapshot())

	changes := append([]model.LevelChange(nil), s.seedChanges...)
	s.seedChanges = nil

	primary := s.primaryCommand(eventTime, anchorMid)
	changes = append(changes, primary.BookChanges...)

	maintenanceChanges, err := maintainLiquidity(s.engine, anchorMid, maintenanceBudget)
	if err != nil {
		panic("simulator maintenance failed: " + err.Error())
	}
	changes = append(changes, maintenanceChanges...)

	s.rev++
	return Event{
		Rev:         s.rev,
		TimeMS:      eventTime,
		Trades:      primary.Trades,
		BookChanges: changes,
		Book:        s.engine.Snapshot(),
	}
}

type commandResult struct {
	Trades      []model.Trade
	BookChanges []model.LevelChange
}

func (s *Simulator) seedBook(midTicks int64) []model.LevelChange {
	changes := make([]model.LevelChange, 0, targetDepth*2)
	for i := 1; i <= targetDepth; i++ {
		bid := midTicks - int64(i)
		ask := midTicks + int64(i)
		bidResult, err := s.engine.Submit(matching.Buy, bid, seededQuantity(i))
		if err != nil || len(bidResult.Fills) != 0 {
			panic("simulator generated invalid bid seed")
		}
		changes = append(changes, bidResult.BookChanges...)
		askResult, err := s.engine.Submit(matching.Sell, ask, seededQuantity(i))
		if err != nil || len(askResult.Fills) != 0 {
			panic("simulator generated invalid ask seed")
		}
		changes = append(changes, askResult.BookChanges...)
	}
	return changes
}

func (s *Simulator) primaryCommand(timeMS int64, anchorMid int64) commandResult {
	if s.rng.IntN(10) == 9 {
		return commandResult{BookChanges: s.cancelRandomOrder()}
	}
	return s.submitRandomOrder(timeMS, anchorMid)
}

func (s *Simulator) submitRandomOrder(timeMS int64, anchorMid int64) commandResult {
	side := matching.Buy
	tradeSide := "buy"
	if s.rng.IntN(2) == 0 {
		side = matching.Sell
		tradeSide = "sell"
	}
	price := anchorMid + int64(s.rng.IntN(int(quoteRadiusTicks*2+1))) - quoteRadiusTicks
	price = clampMidTicks(price)
	quantity := int64(s.rng.IntN(int(maxTradeLots))) + 1
	result, err := s.engine.Submit(side, price, quantity)
	if errors.Is(err, matching.ErrCapacity) {
		return commandResult{}
	}
	if err != nil {
		panic("simulator generated invalid order")
	}
	trades := s.tradesFromFills(timeMS, tradeSide, result.Fills)
	return commandResult{Trades: trades, BookChanges: result.BookChanges}
}

func (s *Simulator) cancelRandomOrder() []model.LevelChange {
	orders := s.engine.Orders()
	if len(orders) == 0 {
		return nil
	}
	order := orders[s.rng.IntN(len(orders))]
	changes, err := s.engine.Cancel(order.ID)
	if err != nil {
		panic("simulator generated invalid cancellation")
	}
	return changes
}

func (s *Simulator) tradesFromFills(timeMS int64, side string, fills []matching.Fill) []model.Trade {
	if len(fills) == 0 {
		return nil
	}
	trades := make([]model.Trade, 0, len(fills))
	for _, fill := range fills {
		trades = append(trades, model.Trade{
			ID:           s.nextTrade,
			TimeMS:       timeMS,
			PriceTicks:   fill.PriceTicks,
			QuantityLots: fill.QuantityLots,
			Side:         side,
		})
		s.nextTrade++
	}
	return trades
}

func clampMidTicks(midTicks int64) int64 {
	minMid := minPriceTicks + int64(targetDepth)
	maxMid := maxPriceTicks - int64(targetDepth)
	if midTicks < minMid {
		return minMid
	}
	if midTicks > maxMid {
		return maxMid
	}
	return midTicks
}

func bookMidpoint(snap model.BookSnapshot) int64 {
	if len(snap.Bids) == 0 && len(snap.Asks) == 0 {
		return defaultMidTicks
	}
	if len(snap.Bids) == 0 {
		return clampMidTicks(snap.Asks[0].PriceTicks)
	}
	if len(snap.Asks) == 0 {
		return clampMidTicks(snap.Bids[0].PriceTicks)
	}
	return clampMidTicks((snap.Bids[0].PriceTicks + snap.Asks[0].PriceTicks) / 2)
}

func seededQuantity(index int) int64 {
	quantity := int64(10000 + (index%10)*1000)
	if quantity > maxBookLots {
		return maxBookLots
	}
	return quantity
}
