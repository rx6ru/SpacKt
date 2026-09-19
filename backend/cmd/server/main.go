package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	address := flag.String("addr", ":8080", "HTTP listen address")
	flag.Parse()
	app, err := NewApp(Config{Seed: 7, DebugControls: true})
	if err != nil {
		slog.Error("server configuration failed", "error", err)
		os.Exit(1)
	}
	server := &http.Server{Addr: *address, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
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
	slog.Info("server listening", "address", *address)
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
