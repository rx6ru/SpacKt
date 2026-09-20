package matching

import (
	"container/list"
	"errors"
	"sort"

	"spackt/internal/model"
)

const maxSafeInteger = uint64(9_007_199_254_740_991)

var (
	ErrInvalidLimits    = errors.New("invalid matching limits")
	ErrInvalidOrder     = errors.New("invalid matching order")
	ErrUnknownOrder     = errors.New("unknown matching order")
	ErrCapacity         = errors.New("matching capacity exceeded")
	ErrCounterExhausted = errors.New("matching counter exhausted")
)

type Engine struct {
	limits      Limits
	nextOrderID uint64
	nextBookSeq uint64
	bids        map[int64]*priceQueue
	asks        map[int64]*priceQueue
	orders      map[uint64]*orderRef
}

type restingOrder struct {
	id            uint64
	side          Side
	priceTicks    int64
	remainingLots int64
}

type priceQueue struct {
	side      Side
	price     int64
	totalLots int64
	orders    *list.List
}

type orderRef struct {
	level   *priceQueue
	element *list.Element
}

type plannedFill struct {
	order    *restingOrder
	level    *priceQueue
	quantity int64
}

func New(limits Limits) (*Engine, error) {
	if limits.MinPriceTicks <= 0 ||
		limits.MaxPriceTicks <= limits.MinPriceTicks ||
		limits.MaxOrderLots <= 0 ||
		limits.MaxLevelLots <= 0 ||
		limits.MaxOrderLots > limits.MaxLevelLots ||
		limits.MaxLevelLots > int64(maxSafeInteger) ||
		limits.MaxOrders <= 0 ||
		limits.MaxOrders > 1024 {
		return nil, ErrInvalidLimits
	}
	return &Engine{
		limits:      limits,
		nextOrderID: 1,
		nextBookSeq: 1,
		bids:        map[int64]*priceQueue{},
		asks:        map[int64]*priceQueue{},
		orders:      map[uint64]*orderRef{},
	}, nil
}

func (e *Engine) Submit(side Side, priceTicks, quantityLots int64) (Result, error) {
	if err := e.validateOrder(side, priceTicks, quantityLots); err != nil {
		return Result{}, err
	}
	if e.nextOrderID > maxSafeInteger {
		return Result{}, ErrCounterExhausted
	}

	fills, remaining := e.planFills(side, priceTicks, quantityLots)
	exhausted := 0
	for _, fill := range fills {
		if fill.quantity == fill.order.remainingLots {
			exhausted++
		}
	}

	if remaining > 0 {
		finalOrders := len(e.orders) - exhausted + 1
		if finalOrders > e.limits.MaxOrders {
			return Result{}, ErrCapacity
		}
		if err := e.checkRestingLevelCapacity(side, priceTicks, remaining); err != nil {
			return Result{}, err
		}
	}

	mutations := len(fills)
	if remaining > 0 {
		mutations++
	}
	if err := e.checkBookSequenceBudget(mutations); err != nil {
		return Result{}, err
	}

	orderID := e.nextOrderID
	e.nextOrderID++
	result := Result{OrderID: orderID, RemainingLots: remaining}
	if len(fills) > 0 {
		result.Fills = make([]Fill, 0, len(fills))
	}
	if mutations > 0 {
		result.BookChanges = make([]model.LevelChange, 0, mutations)
	}

	for _, planned := range fills {
		planned.order.remainingLots -= planned.quantity
		planned.level.totalLots -= planned.quantity
		result.Fills = append(result.Fills, Fill{
			MakerOrderID: planned.order.id,
			PriceTicks:   planned.order.priceTicks,
			QuantityLots: planned.quantity,
		})
		result.BookChanges = append(result.BookChanges, e.nextLevelChange(planned.level))
		if planned.order.remainingLots == 0 {
			e.removeOrder(planned.order.id, planned.level, e.orders[planned.order.id].element)
		}
	}

	if remaining > 0 {
		level := e.ensureLevel(side, priceTicks)
		order := &restingOrder{id: orderID, side: side, priceTicks: priceTicks, remainingLots: remaining}
		element := level.orders.PushBack(order)
		level.totalLots += remaining
		e.orders[orderID] = &orderRef{level: level, element: element}
		result.BookChanges = append(result.BookChanges, e.nextLevelChange(level))
	}

	return cloneResult(result), nil
}

func (e *Engine) Cancel(orderID uint64) ([]model.LevelChange, error) {
	ref := e.orders[orderID]
	if ref == nil {
		return nil, ErrUnknownOrder
	}
	if err := e.checkBookSequenceBudget(1); err != nil {
		return nil, err
	}
	order := ref.element.Value.(*restingOrder)
	ref.level.totalLots -= order.remainingLots
	change := e.nextLevelChange(ref.level)
	e.removeOrder(orderID, ref.level, ref.element)
	return []model.LevelChange{change}, nil
}

func (e *Engine) Snapshot() model.BookSnapshot {
	return model.BookSnapshot{Seq: e.currentBookSeq(), Bids: e.snapshotSide(Buy), Asks: e.snapshotSide(Sell)}
}

func (e *Engine) Orders() []Order {
	ids := make([]uint64, 0, len(e.orders))
	for id := range e.orders {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := make([]Order, 0, len(ids))
	for _, id := range ids {
		ref := e.orders[id]
		order := ref.element.Value.(*restingOrder)
		out = append(out, Order{ID: order.id, Side: order.side, PriceTicks: order.priceTicks, RemainingLots: order.remainingLots})
	}
	return out
}

func (e *Engine) validateOrder(side Side, priceTicks, quantityLots int64) error {
	if side != Buy && side != Sell {
		return ErrInvalidOrder
	}
	if priceTicks < e.limits.MinPriceTicks || priceTicks > e.limits.MaxPriceTicks {
		return ErrInvalidOrder
	}
	if quantityLots <= 0 || quantityLots > e.limits.MaxOrderLots {
		return ErrInvalidOrder
	}
	return nil
}

func (e *Engine) planFills(side Side, priceTicks, quantityLots int64) ([]plannedFill, int64) {
	remaining := quantityLots
	prices := e.compatibleOppositePrices(side, priceTicks)
	fills := make([]plannedFill, 0, minInt(len(e.orders), e.limits.MaxOrders))
	for _, price := range prices {
		if remaining == 0 {
			break
		}
		level := e.oppositeLevels(side)[price]
		if level == nil {
			continue
		}
		for element := level.orders.Front(); element != nil && remaining > 0; element = element.Next() {
			order := element.Value.(*restingOrder)
			quantity := minInt64(remaining, order.remainingLots)
			fills = append(fills, plannedFill{order: order, level: level, quantity: quantity})
			remaining -= quantity
		}
	}
	return fills, remaining
}

func (e *Engine) compatibleOppositePrices(side Side, limit int64) []int64 {
	levels := e.oppositeLevels(side)
	prices := make([]int64, 0, len(levels))
	for price := range levels {
		if side == Buy && price <= limit || side == Sell && price >= limit {
			prices = append(prices, price)
		}
	}
	if side == Buy {
		sort.Slice(prices, func(i, j int) bool { return prices[i] < prices[j] })
	} else {
		sort.Slice(prices, func(i, j int) bool { return prices[i] > prices[j] })
	}
	return prices
}

func (e *Engine) oppositeLevels(side Side) map[int64]*priceQueue {
	if side == Buy {
		return e.asks
	}
	return e.bids
}

func (e *Engine) sameSideLevels(side Side) map[int64]*priceQueue {
	if side == Buy {
		return e.bids
	}
	return e.asks
}

func (e *Engine) checkRestingLevelCapacity(side Side, priceTicks int64, quantityLots int64) error {
	current := int64(0)
	if level := e.sameSideLevels(side)[priceTicks]; level != nil {
		current = level.totalLots
	}
	if quantityLots > e.limits.MaxLevelLots-current {
		return ErrCapacity
	}
	return nil
}

func (e *Engine) checkBookSequenceBudget(mutations int) error {
	if mutations == 0 {
		return nil
	}
	if e.nextBookSeq > maxSafeInteger {
		return ErrCounterExhausted
	}
	if uint64(mutations) > maxSafeInteger-e.nextBookSeq+1 {
		return ErrCounterExhausted
	}
	return nil
}

func (e *Engine) ensureLevel(side Side, priceTicks int64) *priceQueue {
	levels := e.sameSideLevels(side)
	level := levels[priceTicks]
	if level != nil {
		return level
	}
	level = &priceQueue{side: side, price: priceTicks, orders: list.New()}
	levels[priceTicks] = level
	return level
}

func (e *Engine) removeOrder(orderID uint64, level *priceQueue, element *list.Element) {
	level.orders.Remove(element)
	delete(e.orders, orderID)
	if level.orders.Len() == 0 {
		delete(e.sameSideLevels(level.side), level.price)
	}
}

func (e *Engine) nextLevelChange(level *priceQueue) model.LevelChange {
	change := model.LevelChange{Seq: e.nextBookSeq, Side: bookSide(level.side), PriceTicks: level.price, QuantityLots: level.totalLots}
	e.nextBookSeq++
	return change
}

func (e *Engine) snapshotSide(side Side) []model.Level {
	levels := e.sameSideLevels(side)
	if len(levels) == 0 {
		return nil
	}
	prices := make([]int64, 0, len(levels))
	for price := range levels {
		prices = append(prices, price)
	}
	if side == Buy {
		sort.Slice(prices, func(i, j int) bool { return prices[i] > prices[j] })
	} else {
		sort.Slice(prices, func(i, j int) bool { return prices[i] < prices[j] })
	}
	out := make([]model.Level, 0, len(prices))
	for _, price := range prices {
		level := levels[price]
		out = append(out, model.Level{PriceTicks: price, QuantityLots: level.totalLots})
	}
	return out
}

func (e *Engine) currentBookSeq() uint64 {
	if e.nextBookSeq == 0 {
		return maxSafeInteger
	}
	return e.nextBookSeq - 1
}

func bookSide(side Side) model.BookSide {
	if side == Buy {
		return model.BookSideBid
	}
	return model.BookSideAsk
}

func cloneResult(result Result) Result {
	result.Fills = append([]Fill(nil), result.Fills...)
	result.BookChanges = append([]model.LevelChange(nil), result.BookChanges...)
	return result
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func minInt64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}
