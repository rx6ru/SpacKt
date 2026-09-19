package transport

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"spackt/internal/model"
	"spackt/internal/transport/wire"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type MarketReader interface {
	Ready() bool
	Current() model.Publication
	CaptureBook(context.Context) (model.BookCapture, error)
	CaptureHistory(context.Context, model.CandleInterval, int) ([]model.Candle, error)
	CaptureTrades(context.Context, int) ([]model.Trade, error)
}

type Options struct {
	AllowedOrigins         []string
	DebugControls          bool
	MaxConnections         int
	MarketFrameBudgetBytes int
	BookChanges            int
}

type Server struct {
	market      MarketReader
	options     Options
	origins     map[string]bool
	stopping    atomic.Bool
	mu          sync.Mutex
	connections map[string]func()
	admissions  map[string]*tokenBucket
	wg          sync.WaitGroup
}

func NewServer(market MarketReader, options Options) (*Server, error) {
	origins := make(map[string]bool, len(options.AllowedOrigins))
	for _, origin := range options.AllowedOrigins {
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(origin, "*[]\\ ") {
			return nil, errors.New("origins must be exact HTTP or HTTPS origins")
		}
		origins[origin] = true
	}
	if len(origins) == 0 {
		return nil, errors.New("at least one allowed origin is required")
	}
	if options.MaxConnections <= 0 || options.MaxConnections > 100 {
		return nil, errors.New("connection limit must be 1 through 100")
	}
	if options.MarketFrameBudgetBytes <= 0 || options.MarketFrameBudgetBytes > 1<<20 {
		return nil, errors.New("market frame budget must be 1 through 1048576")
	}
	if options.BookChanges <= 0 || options.BookChanges > 4096 {
		return nil, errors.New("book retention must be 1 through 4096")
	}
	return &Server{market: market, options: options, origins: origins, connections: make(map[string]func())}, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/ws" {
		s.serveWebSocket(w, r)
		return
	}
	known := r.URL.Path == "/healthz" || r.URL.Path == "/readyz" || r.URL.Path == "/api/meta" || r.URL.Path == "/api/book" || r.URL.Path == "/api/candles" || r.URL.Path == "/api/trades"
	api := strings.HasPrefix(r.URL.Path, "/api/")
	if api && !s.allowRESTOrigin(w, r) {
		return
	}
	if !known {
		s.writeError(w, http.StatusNotFound, "not_found", "This endpoint does not exist.")
		return
	}
	if r.Method == http.MethodOptions && api {
		s.preflight(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, OPTIONS")
		s.writeError(w, 405, "method_not_allowed", "Use GET for market data.")
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || !validQuery(r.URL.Path, query) {
		s.writeError(w, 400, "bad_request", "Check the request parameters.")
		return
	}
	if r.URL.Path == "/healthz" {
		s.writeJSON(w, 200, "health", wire.Health(true))
		return
	}
	if r.URL.Path == "/readyz" {
		ready := !s.stopping.Load() && s.market.Ready()
		status := 200
		if !ready {
			status = 503
		}
		s.writeJSON(w, status, "readiness", wire.Health(ready))
		return
	}
	if s.stopping.Load() || !s.market.Ready() {
		s.writeError(w, 503, "not_ready", "The market is starting. Try again shortly.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	pub := s.market.Current()
	switch r.URL.Path {
	case "/api/meta":
		s.writeJSON(w, 200, "meta", wire.Metadata(pub, s.options.BookChanges))
	case "/api/book":
		captured, err := s.market.CaptureBook(ctx)
		if s.captureError(w, r, err) {
			return
		}
		s.writeJSON(w, 200, "book", wire.BookResponse(captured))
	case "/api/candles":
		interval := model.CandleInterval(query.Get("interval"))
		limit, _ := queryNumber(query, "limit", 500, 1, 1000)
		id, _ := queryNumber(query, "requestId", 0, 0, 9007199254740991)
		candles, err := s.market.CaptureHistory(ctx, interval, int(limit))
		if s.captureError(w, r, err) {
			return
		}
		s.writeJSON(w, 200, "history", wire.HistoryResponse(pub.Session, interval, id, candles))
	case "/api/trades":
		limit, _ := queryNumber(query, "limit", 50, 1, 100)
		trades, err := s.market.CaptureTrades(ctx, int(limit))
		if s.captureError(w, r, err) {
			return
		}
		s.writeJSON(w, 200, "trades", wire.TradesResponse(pub.Session, trades))
	}
}

func validQuery(path string, q url.Values) bool {
	allowed := map[string]bool{}
	if path == "/api/candles" {
		allowed = map[string]bool{"interval": true, "limit": true, "requestId": true}
		v := q.Get("interval")
		if v != "1s" && v != "1m" && v != "5m" {
			return false
		}
		if _, ok := queryNumber(q, "limit", 500, 1, 1000); !ok {
			return false
		}
		if _, ok := queryNumber(q, "requestId", 0, 0, 9007199254740991); !ok {
			return false
		}
	}
	if path == "/api/trades" {
		allowed["limit"] = true
		if _, ok := queryNumber(q, "limit", 50, 1, 100); !ok {
			return false
		}
	}
	for key, values := range q {
		if !allowed[key] || len(values) != 1 {
			return false
		}
	}
	return true
}
func queryNumber(q url.Values, key string, fallback, min, max uint64) (uint64, bool) {
	values, present := q[key]
	if !present {
		return fallback, true
	}
	if len(values) != 1 || values[0] == "" {
		return 0, false
	}
	for _, c := range values[0] {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(values[0], 10, 53)
	return n, err == nil && n >= min && n <= max
}
func (s *Server) allowRESTOrigin(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Add("Vary", "Origin")
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if !s.origins[origin] {
		s.writeError(w, 403, "origin_denied", "This browser origin is not allowed.")
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	return true
}
func (s *Server) preflight(w http.ResponseWriter, r *http.Request) {
	w.Header().Add("Vary", "Access-Control-Request-Method")
	w.Header().Add("Vary", "Access-Control-Request-Headers")
	valid := s.origins[r.Header.Get("Origin")] && strings.EqualFold(r.Header.Get("Access-Control-Request-Method"), "GET")
	requested := strings.TrimSpace(r.Header.Get("Access-Control-Request-Headers"))
	if requested != "" {
		for _, header := range strings.Split(requested, ",") {
			if !strings.EqualFold(strings.TrimSpace(header), "Accept") {
				valid = false
			}
		}
	}
	if !valid {
		s.writeError(w, 403, "origin_denied", "This preflight request is not allowed.")
		return
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET")
	w.Header().Set("Access-Control-Allow-Headers", "Accept")
	w.WriteHeader(204)
}
func (s *Server) captureError(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	if r.Context().Err() != nil {
		return true
	}
	s.writeError(w, 503, "busy", "The market is busy. Try again shortly.")
	return true
}
func (s *Server) writeError(w http.ResponseWriter, status int, code, message string) {
	s.writeJSON(w, status, "httpError", wire.HTTPError(code, message))
}
func (s *Server) writeJSON(w http.ResponseWriter, status int, kind string, value map[string]any) {
	data, err := wire.Encode(kind, value)
	if err != nil {
		slog.Error("response encoding failed", "kind", kind)
		status = 500
		data = []byte(`{"error":{"code":"internal_error","message":"The response could not be prepared."}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func (s *Server) Close(ctx context.Context) error {
	s.stopping.Store(true)
	s.mu.Lock()
	closers := make([]func(), 0, len(s.connections))
	for _, close := range s.connections {
		closers = append(closers, close)
	}
	s.mu.Unlock()
	for _, close := range closers {
		go close()
	}
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
