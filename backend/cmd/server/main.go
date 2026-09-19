package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"spackt/internal/config"
	"spackt/internal/transport"
	"strconv"
	"syscall"
	"time"
)

func main() {
	address := flag.String("addr", "", "HTTP listen address")
	healthcheck := flag.Bool("healthcheck", false, "check /readyz and exit")
	healthcheckURL := flag.String("healthcheck-url", "", "readiness URL for healthcheck mode")
	flag.Parse()
	if *healthcheck {
		if err := runHealthcheck(*healthcheckURL); err != nil {
			slog.Error("healthcheck failed", "error", err)
			os.Exit(1)
		}
		return
	}
	settings, err := config.Load(os.LookupEnv)
	if err != nil {
		slog.Error("server configuration failed", "error", err)
		os.Exit(1)
	}
	listenAddress := *address
	if listenAddress == "" {
		listenAddress = ":" + strconv.Itoa(settings.Port)
	}
	app, err := NewApp(Config{
		Seed:                   settings.Seed,
		EpochMS:                settings.EpochMS,
		HistoryMinutes:         settings.HistoryMinutes,
		AllowedOrigins:         settings.AllowedOrigins,
		DebugControls:          settings.DebugControls,
		MaxConnections:         settings.MaxConnections,
		MarketFrameBudgetBytes: settings.MarketFrameBudgetBytes,
		BookChanges:            settings.BookChanges,
	})
	if err != nil {
		slog.Error("server configuration failed", "error", err)
		os.Exit(1)
	}
	server := &http.Server{Addr: listenAddress, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	stopping, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-stopping.Done()
		if err := app.Close(); err != nil {
			slog.Error("application shutdown failed", "error", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			slog.Error("HTTP shutdown failed", "error", err)
		}
	}()
	slog.Info("server listening", "address", listenAddress)
	listenErr := server.ListenAndServe()
	if listenErr != nil && !errors.Is(listenErr, http.ErrServerClosed) {
		slog.Error("HTTP server failed", "error", listenErr)
		stop()
	}
	<-stopped
	if listenErr != nil && !errors.Is(listenErr, http.ErrServerClosed) {
		os.Exit(1)
	}
}

func runHealthcheck(rawURL string) error {
	if rawURL == "" {
		port, err := healthcheckPort(os.LookupEnv)
		if err != nil {
			return err
		}
		rawURL = "http://127.0.0.1:" + strconv.Itoa(port) + "/readyz"
	}
	target, err := url.Parse(rawURL)
	if err != nil || target.Scheme != "http" && target.Scheme != "https" || target.Host == "" {
		return errors.New("healthcheck URL must be HTTP or HTTPS")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return transport.CheckReadiness(ctx, target.String())
}

func healthcheckPort(lookup func(string) (string, bool)) (int, error) {
	value, ok := lookup("PORT")
	if !ok {
		return 8080, nil
	}
	if value == "" {
		return 0, errors.New("invalid setting: PORT")
	}
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return 0, errors.New("invalid setting: PORT")
		}
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return 0, errors.New("invalid setting: PORT")
	}
	return port, nil
}
