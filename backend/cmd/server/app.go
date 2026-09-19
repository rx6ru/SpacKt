package main

import (
	"errors"
	"net/http"
)

type Config struct {
	Seed                   int64
	EpochMS                int64
	HistoryMinutes         int
	AllowedOrigins         []string
	DebugControls          bool
	MaxConnections         int
	MarketFrameBudgetBytes int
	BookChanges            int
}
type App struct{}

func NewApp(Config) (*App, error)  { return nil, errors.New("not implemented") }
func (*App) Handler() http.Handler { return http.NotFoundHandler() }
func (*App) Close() error          { return nil }
