package matching

import (
	"errors"
	"spackt/internal/model"
)

const maxSafeInteger = uint64(9_007_199_254_740_991)

var (
	ErrInvalidLimits    = errors.New("invalid matching limits")
	ErrInvalidOrder     = errors.New("invalid matching order")
	ErrUnknownOrder     = errors.New("unknown matching order")
	ErrCapacity         = errors.New("matching capacity exceeded")
	ErrCounterExhausted = errors.New("matching counter exhausted")
	errUnimplemented    = errors.New("matching behavior is not implemented")
)

type Engine struct {
	limits      Limits
	nextOrderID uint64
	nextBookSeq uint64
}

func New(limits Limits) (*Engine, error) {
	if limits.MinPriceTicks <= 0 ||
		limits.MaxPriceTicks < limits.MinPriceTicks ||
		limits.MaxOrderLots <= 0 ||
		limits.MaxLevelLots <= 0 ||
		limits.MaxOrderLots > limits.MaxLevelLots ||
		limits.MaxLevelLots > int64(maxSafeInteger) ||
		limits.MaxOrders <= 0 ||
		limits.MaxOrders > 1024 {
		return nil, ErrInvalidLimits
	}
	return &Engine{limits: limits, nextOrderID: 1, nextBookSeq: 1}, nil
}

func (e *Engine) Submit(side Side, priceTicks, quantityLots int64) (Result, error) {
	return Result{}, errUnimplemented
}

func (e *Engine) Cancel(orderID uint64) ([]model.LevelChange, error) {
	return nil, errUnimplemented
}

func (e *Engine) Snapshot() model.BookSnapshot {
	return model.BookSnapshot{}
}

func (e *Engine) Orders() []Order {
	return nil
}
