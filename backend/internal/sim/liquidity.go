package sim

import (
	"errors"

	"spackt/internal/matching"
	"spackt/internal/model"
)

var errMaintenanceBudget = errors.New("maintenance budget exhausted")

func maintainLiquidity(engine *matching.Engine, anchorMid int64, budget int) ([]model.LevelChange, error) {
	return nil, errMaintenanceBudget
}
