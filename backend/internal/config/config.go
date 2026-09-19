package config

import "errors"

var ErrInvalidSetting = errors.New("invalid setting")

type Settings struct {
	Port                   int
	Seed                   int64
	EpochMS                int64
	HistoryMinutes         int
	AllowedOrigins         []string
	DebugControls          bool
	MaxConnections         int
	MarketFrameBudgetBytes int
	BookChanges            int
}

func Load(lookup func(string) (string, bool)) (Settings, error) {
	return Settings{}, errors.New("config loading is not implemented")
}
