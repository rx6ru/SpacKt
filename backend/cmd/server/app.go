package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"spackt/internal/market"
	"spackt/internal/transport"
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

type App struct {
	owner      *market.Owner
	server     *transport.Server
	cancel     context.CancelFunc
	started    chan struct{}
	closeOnce  sync.Once
	closeError error
}

func NewApp(cfg Config) (*App, error) {
	if cfg.HistoryMinutes == 0 {
		cfg.HistoryMinutes = 360
	}
	if cfg.HistoryMinutes < 1 || cfg.HistoryMinutes > 1440 {
		return nil, errors.New("history must be 1 through 1440 minutes")
	}
	if cfg.EpochMS == 0 {
		cfg.EpochMS = time.Now().Add(-time.Duration(cfg.HistoryMinutes) * time.Minute).UnixMilli()
	}
	if cfg.EpochMS < 0 || cfg.EpochMS > 9007199254740991-int64(cfg.HistoryMinutes)*60000 {
		return nil, errors.New("history epoch is outside supported time bounds")
	}
	if cfg.MaxConnections == 0 {
		cfg.MaxConnections = 100
	}
	if cfg.MarketFrameBudgetBytes == 0 {
		cfg.MarketFrameBudgetBytes = 1 << 20
	}
	if cfg.BookChanges == 0 {
		cfg.BookChanges = 4096
	}
	if len(cfg.AllowedOrigins) == 0 {
		cfg.AllowedOrigins = []string{"http://localhost:3000", "http://127.0.0.1:3000"}
	}
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return nil, err
	}
	ownerConfig := market.DefaultConfig()
	ownerConfig.Session = "s_" + hex.EncodeToString(bytes)
	ownerConfig.Seed, ownerConfig.EpochMS, ownerConfig.HistoryMinutes = cfg.Seed, cfg.EpochMS, cfg.HistoryMinutes
	ownerConfig.Retention.BookChanges = cfg.BookChanges
	owner, err := market.NewOwner(ownerConfig, nil)
	if err != nil {
		return nil, err
	}
	server, err := transport.NewServer(owner, transport.Options{AllowedOrigins: cfg.AllowedOrigins, DebugControls: cfg.DebugControls, MaxConnections: cfg.MaxConnections, MarketFrameBudgetBytes: cfg.MarketFrameBudgetBytes, BookChanges: cfg.BookChanges})
	if err != nil {
		_ = owner.Close(context.Background())
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	app := &App{owner: owner, server: server, cancel: cancel, started: make(chan struct{})}
	go func() {
		defer close(app.started)
		if err := owner.Start(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("market startup failed", "error", err)
		}
	}()
	return app, nil
}

func (a *App) Handler() http.Handler { return a.server }
func (a *App) Close() error {
	a.closeOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		serverError := a.server.Close(ctx)
		a.cancel()
		ownerError := a.owner.Close(ctx)
		select {
		case <-a.started:
		case <-ctx.Done():
			ownerError = ctx.Err()
		}
		a.closeError = errors.Join(serverError, ownerError)
	})
	return a.closeError
}
