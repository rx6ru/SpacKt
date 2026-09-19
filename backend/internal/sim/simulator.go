package sim

import (
	"math/rand/v2"
	"spackt/internal/book"
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
	Trade       *model.Trade
	BookChanges []book.LevelUpdate
	Book        model.BookSnapshot
}

type Simulator struct {
	rng       *rand.Rand
	book      *book.Book
	epochMS   int64
	stepMS    int64
	nextIndex int64
	rev       uint64
	nextTrade uint64
}

const (
	defaultMidTicks = int64(6400000)
	defaultStepMS   = int64(100)
	minPriceTicks   = int64(10000)
	maxPriceTicks   = int64(10000000)
	maxTradeLots    = int64(10000)
	maxBookLots     = int64(100000)
	targetDepth     = 20
	maxDepth        = 50
)

func New(config Config) *Simulator {
	if config.MidTicks == 0 {
		config.MidTicks = defaultMidTicks
	}
	config.MidTicks = clampMidTicks(config.MidTicks)
	if config.StepMS == 0 {
		config.StepMS = defaultStepMS
	}
	return &Simulator{
		rng:       rand.New(rand.NewPCG(uint64(config.Seed), uint64(config.Seed)^0x9e3779b97f4a7c15)),
		book:      book.NewBounded(config.MidTicks, minPriceTicks, maxPriceTicks),
		epochMS:   config.EpochMS,
		stepMS:    config.StepMS,
		nextTrade: 1,
	}
}

func (s *Simulator) Next() Event {
	eventTime := s.epochMS + s.nextIndex*s.stepMS
	s.nextIndex++

	var trade *model.Trade
	var changes []book.LevelUpdate
	switch draw := s.rng.IntN(10); {
	case draw < 8:
		trade, changes = s.marketTrade(eventTime)
	case draw == 8:
		changes = s.limitAddition()
	default:
		changes = s.cancellation()
	}

	changes = append(changes, s.repairBook()...)
	s.rev++
	return Event{
		Rev:         s.rev,
		TimeMS:      eventTime,
		Trade:       trade,
		BookChanges: changes,
		Book:        s.book.Snapshot(),
	}
}

func (s *Simulator) marketTrade(timeMS int64) (*model.Trade, []book.LevelUpdate) {
	snap := s.book.Snapshot()
	side := "buy"
	best := snap.Asks[0]
	if s.rng.IntN(2) == 0 {
		side = "sell"
		best = snap.Bids[0]
	}
	limit := best.QuantityLots
	if limit > maxTradeLots {
		limit = maxTradeLots
	}
	if limit <= 0 {
		panic("simulator selected non-positive book quantity")
	}
	trade := model.Trade{
		ID:           s.nextTrade,
		TimeMS:       timeMS,
		PriceTicks:   best.PriceTicks,
		QuantityLots: int64(s.rng.IntN(int(limit))) + 1,
		Side:         side,
	}
	changes, err := s.book.ApplyTrade(trade)
	if err != nil {
		panic("simulator generated invalid trade")
	}
	s.nextTrade++
	return &trade, changes
}

func (s *Simulator) limitAddition() []book.LevelUpdate {
	snap := s.book.Snapshot()
	side := book.SideBid
	if s.rng.IntN(2) == 0 {
		side = book.SideAsk
	}

	var price int64
	if side == book.SideBid {
		bestBid := snap.Bids[0].PriceTicks
		bestAsk := snap.Asks[0].PriceTicks
		price = bestBid - int64(s.rng.IntN(5))
		if price >= bestAsk {
			price = bestAsk - 1
		}
		if price < minPriceTicks {
			price = minPriceTicks
		}
		if price >= bestAsk {
			price = bestBid
		}
	} else {
		bestBid := snap.Bids[0].PriceTicks
		bestAsk := snap.Asks[0].PriceTicks
		price = bestAsk + int64(s.rng.IntN(5))
		if price <= bestBid {
			price = bestBid + 1
		}
		if price > maxPriceTicks {
			price = maxPriceTicks
		}
		if price <= bestBid {
			price = bestAsk
		}
	}

	return s.apply(book.LevelUpdate{
		Side:         side,
		PriceTicks:   price,
		QuantityLots: int64(s.rng.IntN(int(maxBookLots))) + 1,
	})
}

func (s *Simulator) cancellation() []book.LevelUpdate {
	snap := s.book.Snapshot()
	side := book.SideBid
	levels := snap.Bids
	if s.rng.IntN(2) == 0 {
		side = book.SideAsk
		levels = snap.Asks
	}
	if len(levels) == 0 {
		panic("simulator selected an empty book side for cancellation")
	}
	level := levels[s.rng.IntN(len(levels))]
	removeLots := int64(s.rng.IntN(int(level.QuantityLots))) + 1
	nextQuantity := level.QuantityLots - removeLots
	return s.apply(book.LevelUpdate{
		Side:         side,
		PriceTicks:   level.PriceTicks,
		QuantityLots: nextQuantity,
	})
}

func (s *Simulator) repairBook() []book.LevelUpdate {
	var changes []book.LevelUpdate
	for {
		snap := s.book.Snapshot()
		if len(snap.Bids) >= targetDepth && len(snap.Asks) >= targetDepth && len(snap.Bids) <= maxDepth && len(snap.Asks) <= maxDepth {
			return changes
		}
		switch {
		case len(snap.Bids) < targetDepth:
			price, ok := repairPrice(snap, book.SideBid)
			if !ok {
				panic("simulator cannot repair bid depth within price bounds")
			}
			changes = append(changes, s.apply(book.LevelUpdate{Side: book.SideBid, PriceTicks: price, QuantityLots: repairQuantity(len(snap.Bids))})...)
		case len(snap.Asks) < targetDepth:
			price, ok := repairPrice(snap, book.SideAsk)
			if !ok {
				panic("simulator cannot repair ask depth within price bounds")
			}
			changes = append(changes, s.apply(book.LevelUpdate{Side: book.SideAsk, PriceTicks: price, QuantityLots: repairQuantity(len(snap.Asks))})...)
		case len(snap.Bids) > maxDepth:
			changes = append(changes, s.apply(book.LevelUpdate{Side: book.SideBid, PriceTicks: snap.Bids[len(snap.Bids)-1].PriceTicks, QuantityLots: 0})...)
		case len(snap.Asks) > maxDepth:
			changes = append(changes, s.apply(book.LevelUpdate{Side: book.SideAsk, PriceTicks: snap.Asks[len(snap.Asks)-1].PriceTicks, QuantityLots: 0})...)
		}
	}
}

func (s *Simulator) apply(update book.LevelUpdate) []book.LevelUpdate {
	if err := s.book.Apply(update); err != nil {
		panic("simulator generated invalid book update")
	}
	update.Seq = s.book.Snapshot().Seq
	return []book.LevelUpdate{update}
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

func repairPrice(snap model.BookSnapshot, side string) (int64, bool) {
	if side == book.SideBid {
		if price := snap.Bids[len(snap.Bids)-1].PriceTicks - 1; canPlaceBid(snap, price) {
			return price, true
		}
		for price := snap.Asks[0].PriceTicks - 1; price >= minPriceTicks; price-- {
			if canPlaceBid(snap, price) {
				return price, true
			}
			if price == minPriceTicks {
				break
			}
		}
		return 0, false
	}

	if price := snap.Asks[len(snap.Asks)-1].PriceTicks + 1; canPlaceAsk(snap, price) {
		return price, true
	}
	for price := snap.Bids[0].PriceTicks + 1; price <= maxPriceTicks; price++ {
		if canPlaceAsk(snap, price) {
			return price, true
		}
		if price == maxPriceTicks {
			break
		}
	}
	return 0, false
}

func canPlaceBid(snap model.BookSnapshot, price int64) bool {
	if price < minPriceTicks || price > maxPriceTicks || price >= snap.Asks[0].PriceTicks {
		return false
	}
	return !containsPrice(snap.Bids, price)
}

func canPlaceAsk(snap model.BookSnapshot, price int64) bool {
	if price < minPriceTicks || price > maxPriceTicks || price <= snap.Bids[0].PriceTicks {
		return false
	}
	return !containsPrice(snap.Asks, price)
}

func containsPrice(levels []model.Level, price int64) bool {
	for _, level := range levels {
		if level.PriceTicks == price {
			return true
		}
	}
	return false
}

func repairQuantity(index int) int64 {
	return int64(10000 + (index%10)*1000)
}
