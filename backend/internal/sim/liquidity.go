package sim

import (
	"errors"
	"fmt"

	"spackt/internal/matching"
	"spackt/internal/model"
)

var errMaintenanceBudget = errors.New("maintenance budget exhausted")

func maintainLiquidity(engine *matching.Engine, anchorMid int64, budget int) ([]model.LevelChange, error) {
	plan := newMaintenancePlan(engine, anchorMid, budget)
	if err := plan.run(); err != nil {
		return nil, err
	}
	return plan.changes, nil
}

type maintenancePlan struct {
	engine    *matching.Engine
	anchorMid int64
	budget    int
	changes   []model.LevelChange
}

func newMaintenancePlan(engine *matching.Engine, anchorMid int64, budget int) *maintenancePlan {
	return &maintenancePlan{engine: engine, anchorMid: clampMidTicks(anchorMid), budget: budget}
}

func (m *maintenancePlan) run() error {
	if m.budget < 2 {
		return errMaintenanceBudget
	}
	snap := m.engine.Snapshot()
	if healthyBook(snap) && m.engine.OrderCount()+2 <= matchingOrderCap {
		return nil
	}
	if err := m.trimExcessLevels(); err != nil {
		return err
	}
	if err := m.reserveCapacity(); err != nil {
		return err
	}
	if err := m.addMissingBids(); err != nil {
		return err
	}
	if err := m.addMissingAsks(); err != nil {
		return err
	}
	if err := m.repairSpread(); err != nil {
		return err
	}
	if err := m.trimExcessLevels(); err != nil {
		return err
	}
	return m.validate()
}

func healthyBook(snap model.BookSnapshot) bool {
	if len(snap.Bids) < targetDepth || len(snap.Bids) > maxDepth || len(snap.Asks) < targetDepth || len(snap.Asks) > maxDepth {
		return false
	}
	if len(snap.Bids) == 0 || len(snap.Asks) == 0 || snap.Bids[0].PriceTicks >= snap.Asks[0].PriceTicks {
		return false
	}
	spread := snap.Asks[0].PriceTicks - snap.Bids[0].PriceTicks
	return spread >= 1 && spread <= maxSpreadTicks
}

func (m *maintenancePlan) trimExcessLevels() error {
	for {
		snap := m.engine.Snapshot()
		side := matching.Side("")
		price := int64(0)
		switch {
		case len(snap.Bids) > maxDepth:
			side = matching.Buy
			price = snap.Bids[maxDepth].PriceTicks
		case len(snap.Asks) > maxDepth:
			side = matching.Sell
			price = snap.Asks[maxDepth].PriceTicks
		default:
			return nil
		}
		if err := m.cancelOrdersAt(side, price); err != nil {
			return err
		}
	}
}

func (m *maintenancePlan) reserveCapacity() error {
	missing := m.missingLevels() + 2
	for m.engine.OrderCount()+missing > matchingOrderCap {
		orders := m.engine.Orders()
		index := m.oldestDuplicateOrderIndex(orders)
		if index < 0 {
			return fmt.Errorf("maintenance cannot reserve matching capacity")
		}
		if err := m.cancelOrder(orders[index].ID); err != nil {
			return err
		}
	}
	return nil
}

func (m *maintenancePlan) missingLevels() int {
	snap := m.engine.Snapshot()
	missing := 0
	if len(snap.Bids) < targetDepth {
		missing += targetDepth - len(snap.Bids)
	}
	if len(snap.Asks) < targetDepth {
		missing += targetDepth - len(snap.Asks)
	}
	return missing
}

func (m *maintenancePlan) oldestDuplicateOrderIndex(orders []matching.Order) int {
	counts := make(map[sidePrice]int, len(orders))
	for _, order := range orders {
		counts[sidePrice{side: order.Side, price: order.PriceTicks}]++
	}
	for i, order := range orders {
		if counts[sidePrice{side: order.Side, price: order.PriceTicks}] > 1 {
			return i
		}
	}
	return -1
}

type sidePrice struct {
	side  matching.Side
	price int64
}

func (m *maintenancePlan) addMissingBids() error {
	for {
		snap := m.engine.Snapshot()
		if len(snap.Bids) >= targetDepth {
			return nil
		}
		price, ok := m.findBidPrice(false)
		if !ok {
			return fmt.Errorf("maintenance cannot find bid price")
		}
		if err := m.submitPassive(matching.Buy, price, seededQuantity(len(snap.Bids)+1)); err != nil {
			return err
		}
	}
}

func (m *maintenancePlan) addMissingAsks() error {
	for {
		snap := m.engine.Snapshot()
		if len(snap.Asks) >= targetDepth {
			return nil
		}
		price, ok := m.findAskPrice(false)
		if !ok {
			return fmt.Errorf("maintenance cannot find ask price")
		}
		if err := m.submitPassive(matching.Sell, price, seededQuantity(len(snap.Asks)+1)); err != nil {
			return err
		}
	}
}

func (m *maintenancePlan) repairSpread() error {
	snap := m.engine.Snapshot()
	if len(snap.Bids) == 0 || len(snap.Asks) == 0 || snap.Asks[0].PriceTicks-snap.Bids[0].PriceTicks <= maxSpreadTicks {
		return nil
	}
	if price, ok := m.findBidPrice(true); ok {
		if err := m.submitPassive(matching.Buy, price, seededQuantity(len(snap.Bids)+1)); err != nil {
			return err
		}
	}
	snap = m.engine.Snapshot()
	if len(snap.Bids) == 0 || len(snap.Asks) == 0 || snap.Asks[0].PriceTicks-snap.Bids[0].PriceTicks <= maxSpreadTicks {
		return nil
	}
	if price, ok := m.findAskPrice(true); ok {
		if err := m.submitPassive(matching.Sell, price, seededQuantity(len(snap.Asks)+1)); err != nil {
			return err
		}
	}
	return nil
}

func (m *maintenancePlan) findBidPrice(improve bool) (int64, bool) {
	snap := m.engine.Snapshot()
	start := m.anchorMid - 1
	if len(snap.Bids) > 0 && !improve && snap.Bids[len(snap.Bids)-1].PriceTicks > minPriceTicks {
		start = snap.Bids[len(snap.Bids)-1].PriceTicks - 1
	}
	if improve {
		start = m.anchorMid - maxSpreadTicks/2
	}
	if len(snap.Asks) > 0 && start >= snap.Asks[0].PriceTicks {
		start = snap.Asks[0].PriceTicks - 1
	}
	if start > maxPriceTicks-int64(targetDepth) {
		start = maxPriceTicks - int64(targetDepth)
	}
	if start < minPriceTicks {
		start = minPriceTicks
	}
	for i := 0; i < maxDepth+1; i++ {
		price := start - int64(i)
		if price < minPriceTicks {
			break
		}
		if improve && len(snap.Bids) > 0 && price <= snap.Bids[0].PriceTicks {
			break
		}
		if canRestBid(snap, price) {
			return price, true
		}
	}
	return 0, false
}

func (m *maintenancePlan) findAskPrice(improve bool) (int64, bool) {
	snap := m.engine.Snapshot()
	start := m.anchorMid + 1
	if len(snap.Asks) > 0 && !improve && snap.Asks[len(snap.Asks)-1].PriceTicks < maxPriceTicks {
		start = snap.Asks[len(snap.Asks)-1].PriceTicks + 1
	}
	if improve {
		start = m.anchorMid + maxSpreadTicks/2
	}
	if len(snap.Bids) > 0 && start <= snap.Bids[0].PriceTicks {
		start = snap.Bids[0].PriceTicks + 1
	}
	if start < minPriceTicks+int64(targetDepth) {
		start = minPriceTicks + int64(targetDepth)
	}
	if start > maxPriceTicks {
		start = maxPriceTicks
	}
	for i := 0; i < maxDepth+1; i++ {
		price := start + int64(i)
		if price > maxPriceTicks {
			break
		}
		if improve && len(snap.Asks) > 0 && price >= snap.Asks[0].PriceTicks {
			break
		}
		if canRestAsk(snap, price) {
			return price, true
		}
	}
	return 0, false
}

func canRestBid(snap model.BookSnapshot, price int64) bool {
	if price < minPriceTicks || price > maxPriceTicks-int64(targetDepth) {
		return false
	}
	if len(snap.Asks) > 0 && price >= snap.Asks[0].PriceTicks {
		return false
	}
	return !levelExists(snap.Bids, price)
}

func canRestAsk(snap model.BookSnapshot, price int64) bool {
	if price < minPriceTicks+int64(targetDepth) || price > maxPriceTicks {
		return false
	}
	if len(snap.Bids) > 0 && price <= snap.Bids[0].PriceTicks {
		return false
	}
	return !levelExists(snap.Asks, price)
}

func levelExists(levels []model.Level, price int64) bool {
	for _, level := range levels {
		if level.PriceTicks == price {
			return true
		}
	}
	return false
}

func (m *maintenancePlan) cancelOrdersAt(side matching.Side, price int64) error {
	for _, order := range m.engine.Orders() {
		if order.Side == side && order.PriceTicks == price {
			if err := m.cancelOrder(order.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (m *maintenancePlan) cancelOrder(orderID uint64) error {
	if err := m.spend(); err != nil {
		return err
	}
	changes, err := m.engine.Cancel(orderID)
	if err != nil {
		return err
	}
	m.changes = append(m.changes, changes...)
	return nil
}

func (m *maintenancePlan) submitPassive(side matching.Side, price int64, quantity int64) error {
	if err := m.spend(); err != nil {
		return err
	}
	result, err := m.engine.Submit(side, price, quantity)
	if err != nil {
		return err
	}
	if len(result.Fills) != 0 {
		return fmt.Errorf("maintenance generated active fills")
	}
	m.changes = append(m.changes, result.BookChanges...)
	return nil
}

func (m *maintenancePlan) spend() error {
	if m.budget <= 0 {
		return errMaintenanceBudget
	}
	m.budget--
	return nil
}

func (m *maintenancePlan) validate() error {
	snap := m.engine.Snapshot()
	if len(snap.Bids) < targetDepth || len(snap.Bids) > maxDepth || len(snap.Asks) < targetDepth || len(snap.Asks) > maxDepth {
		return fmt.Errorf("maintenance depth invariant failed")
	}
	if len(snap.Bids) == 0 || len(snap.Asks) == 0 || snap.Bids[0].PriceTicks >= snap.Asks[0].PriceTicks {
		return fmt.Errorf("maintenance crossed book invariant failed")
	}
	spread := snap.Asks[0].PriceTicks - snap.Bids[0].PriceTicks
	if spread < 1 || spread > maxSpreadTicks {
		return fmt.Errorf("maintenance spread invariant failed")
	}
	if m.engine.OrderCount() > matchingOrderCap {
		return fmt.Errorf("maintenance order cap invariant failed")
	}
	for _, level := range append(append([]model.Level(nil), snap.Bids...), snap.Asks...) {
		if level.QuantityLots <= 0 || level.QuantityLots > maxBookLots {
			return fmt.Errorf("maintenance level quantity invariant failed")
		}
	}
	return nil
}
