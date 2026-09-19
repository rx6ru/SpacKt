package book

import (
	"errors"
	"sort"
	"spackt/internal/model"
)

const (
	SideBid = "bid"
	SideAsk = "ask"
)

type LevelUpdate struct {
	Seq          uint64
	Side         string // "bid" or "ask"
	PriceTicks   int64
	QuantityLots int64 // zero removes the level
}

type Book struct {
	seq           uint64
	minPriceTicks int64
	maxPriceTicks int64
	bids          map[int64]int64
	asks          map[int64]int64
}

const (
	targetDepth            = 20
	maxDepth               = 50
	maxLevelLots           = 100000
	defaultMinPriceTicks   = int64(1)
	unboundedMaxPriceTicks = int64(1<<63 - 1)
)

var (
	errInvalidSide     = errors.New("invalid side")
	errInvalidPrice    = errors.New("invalid price")
	errInvalidQuantity = errors.New("invalid quantity")
	errCallerSequence  = errors.New("caller sequence must be zero")
	errCrossedBook     = errors.New("crossed book")
	errInvalidTrade    = errors.New("invalid trade")
)

func New(midTicks int64) *Book {
	return NewBounded(midTicks, defaultMinPriceTicks, unboundedMaxPriceTicks)
}

func NewBounded(midTicks, minPriceTicks, maxPriceTicks int64) *Book {
	if minPriceTicks < defaultMinPriceTicks {
		minPriceTicks = defaultMinPriceTicks
	}
	if maxPriceTicks-minPriceTicks < int64(targetDepth*2) {
		panic("book price bounds cannot hold target depth")
	}
	minMid := minPriceTicks + int64(targetDepth)
	maxMid := maxPriceTicks - int64(targetDepth)
	if midTicks < minMid {
		midTicks = minMid
	}
	if midTicks > maxMid {
		midTicks = maxMid
	}
	b := &Book{
		minPriceTicks: minPriceTicks,
		maxPriceTicks: maxPriceTicks,
		bids:          make(map[int64]int64, maxDepth),
		asks:          make(map[int64]int64, maxDepth),
	}
	for i := 1; i <= targetDepth; i++ {
		b.bids[midTicks-int64(i)] = seededQuantity(i)
		b.asks[midTicks+int64(i)] = seededQuantity(i)
	}
	return b
}

func (b *Book) Snapshot() model.BookSnapshot {
	return model.BookSnapshot{
		Seq:  b.seq,
		Bids: sortedLevels(b.bids, true),
		Asks: sortedLevels(b.asks, false),
	}
}

func (b *Book) Apply(update LevelUpdate) error {
	if update.Seq != 0 {
		return errCallerSequence
	}
	nextBids := cloneSide(b.bids)
	nextAsks := cloneSide(b.asks)
	if err := b.applyToSides(nextBids, nextAsks, update); err != nil {
		return err
	}
	if crossed(nextBids, nextAsks) {
		return errCrossedBook
	}
	b.bids = nextBids
	b.asks = nextAsks
	b.seq++
	return nil
}

func (b *Book) ApplyTrade(trade model.Trade) ([]LevelUpdate, error) {
	if trade.QuantityLots <= 0 {
		return nil, errInvalidTrade
	}
	var side string
	var levels map[int64]int64
	var price int64
	var available int64
	switch trade.Side {
	case "buy":
		side = SideAsk
		levels = b.asks
		price, available = bestAsk(levels)
	case "sell":
		side = SideBid
		levels = b.bids
		price, available = bestBid(levels)
	default:
		return nil, errInvalidTrade
	}
	if available <= 0 || trade.PriceTicks != price || trade.QuantityLots > available {
		return nil, errInvalidTrade
	}

	changes := make([]LevelUpdate, 0, 1+targetDepth)
	remaining := available - trade.QuantityLots
	b.appendMutation(&changes, side, price, remaining)
	b.repair(&changes)
	return changes, nil
}

func (b *Book) repair(changes *[]LevelUpdate) {
	b.replenishSide(changes, SideBid)
	b.replenishSide(changes, SideAsk)
	b.trimSide(changes, SideBid)
	b.trimSide(changes, SideAsk)
}

func (b *Book) replenishSide(changes *[]LevelUpdate, side string) {
	for len(sideMap(b, side)) < targetDepth {
		price, ok := b.replenishPrice(side)
		if !ok {
			panic("book cannot replenish side within price bounds")
		}
		b.appendMutation(changes, side, price, seededQuantity(len(sideMap(b, side))+1))
	}
}

func (b *Book) trimSide(changes *[]LevelUpdate, side string) {
	for len(sideMap(b, side)) > maxDepth {
		var price int64
		if side == SideBid {
			price = worstBid(b.bids)
		} else {
			price = worstAsk(b.asks)
		}
		b.appendMutation(changes, side, price, 0)
	}
}

func (b *Book) appendMutation(changes *[]LevelUpdate, side string, priceTicks, quantityLots int64) {
	b.seq++
	update := LevelUpdate{
		Seq:          b.seq,
		Side:         side,
		PriceTicks:   priceTicks,
		QuantityLots: quantityLots,
	}
	if quantityLots == 0 {
		delete(sideMap(b, side), priceTicks)
	} else {
		sideMap(b, side)[priceTicks] = quantityLots
	}
	*changes = append(*changes, update)
}

func (b *Book) applyToSides(bids, asks map[int64]int64, update LevelUpdate) error {
	if update.PriceTicks < b.minPriceTicks || update.PriceTicks > b.maxPriceTicks {
		return errInvalidPrice
	}
	if update.QuantityLots < 0 || update.QuantityLots > maxLevelLots {
		return errInvalidQuantity
	}
	switch update.Side {
	case SideBid:
		applyToMap(bids, update.PriceTicks, update.QuantityLots)
	case SideAsk:
		applyToMap(asks, update.PriceTicks, update.QuantityLots)
	default:
		return errInvalidSide
	}
	return nil
}

func (b *Book) replenishPrice(side string) (int64, bool) {
	if side == SideBid {
		if price := worstBid(b.bids) - 1; b.canPlaceBid(price) {
			return price, true
		}
		ask, _ := bestAsk(b.asks)
		for price := minInt64(ask-1, b.maxPriceTicks); price >= b.minPriceTicks; price-- {
			if b.canPlaceBid(price) {
				return price, true
			}
			if price == b.minPriceTicks {
				break
			}
		}
		return 0, false
	}

	if price := worstAsk(b.asks) + 1; b.canPlaceAsk(price) {
		return price, true
	}
	bid, _ := bestBid(b.bids)
	for price := maxInt64(bid+1, b.minPriceTicks); price <= b.maxPriceTicks; price++ {
		if b.canPlaceAsk(price) {
			return price, true
		}
		if price == b.maxPriceTicks {
			break
		}
	}
	return 0, false
}

func (b *Book) canPlaceBid(price int64) bool {
	if price < b.minPriceTicks || price > b.maxPriceTicks {
		return false
	}
	if _, exists := b.bids[price]; exists {
		return false
	}
	bestAskPrice, bestAskQuantity := bestAsk(b.asks)
	return bestAskQuantity == 0 || price < bestAskPrice
}

func (b *Book) canPlaceAsk(price int64) bool {
	if price < b.minPriceTicks || price > b.maxPriceTicks {
		return false
	}
	if _, exists := b.asks[price]; exists {
		return false
	}
	bestBidPrice, bestBidQuantity := bestBid(b.bids)
	return bestBidQuantity == 0 || price > bestBidPrice
}

func applyToMap(levels map[int64]int64, priceTicks, quantityLots int64) {
	if quantityLots == 0 {
		delete(levels, priceTicks)
		return
	}
	levels[priceTicks] = quantityLots
}

func sortedLevels(levels map[int64]int64, desc bool) []model.Level {
	out := make([]model.Level, 0, len(levels))
	for price, quantity := range levels {
		out = append(out, model.Level{PriceTicks: price, QuantityLots: quantity})
	}
	sort.Slice(out, func(i, j int) bool {
		if desc {
			return out[i].PriceTicks > out[j].PriceTicks
		}
		return out[i].PriceTicks < out[j].PriceTicks
	})
	return out
}

func cloneSide(levels map[int64]int64) map[int64]int64 {
	out := make(map[int64]int64, len(levels))
	for price, quantity := range levels {
		out[price] = quantity
	}
	return out
}

func crossed(bids, asks map[int64]int64) bool {
	bid, bidOK := bestBid(bids)
	ask, askOK := bestAsk(asks)
	return bidOK > 0 && askOK > 0 && bid >= ask
}

func sideMap(b *Book, side string) map[int64]int64 {
	if side == SideBid {
		return b.bids
	}
	return b.asks
}

func seededQuantity(index int) int64 {
	return int64(10000 + (index%10)*1000)
}

func bestBid(levels map[int64]int64) (int64, int64) {
	var price int64
	var quantity int64
	for p, q := range levels {
		if quantity == 0 || p > price {
			price, quantity = p, q
		}
	}
	return price, quantity
}

func bestAsk(levels map[int64]int64) (int64, int64) {
	var price int64
	var quantity int64
	for p, q := range levels {
		if quantity == 0 || p < price {
			price, quantity = p, q
		}
	}
	return price, quantity
}

func worstBid(levels map[int64]int64) int64 {
	sorted := sortedLevels(levels, true)
	return sorted[len(sorted)-1].PriceTicks
}

func worstAsk(levels map[int64]int64) int64 {
	sorted := sortedLevels(levels, false)
	return sorted[len(sorted)-1].PriceTicks
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
