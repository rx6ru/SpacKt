package transport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"spackt/internal/delivery"
	"spackt/internal/model"
	"spackt/internal/transport/wire"
)

func (s *Server) serveWebSocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		s.writeError(w, 405, "method_not_allowed", "Use GET to open a connection.")
		return
	}
	if r.URL.RawQuery != "" {
		s.writeError(w, 400, "bad_request", "This endpoint has no query parameters.")
		return
	}
	origin := r.Header.Get("Origin")
	if !s.origins[origin] {
		s.writeError(w, 403, "origin_denied", "This browser origin is not allowed.")
		return
	}
	if s.stopping.Load() || !s.market.Ready() {
		s.writeError(w, 503, "not_ready", "The market is starting. Try again shortly.")
		return
	}
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peer = r.RemoteAddr
	}
	if !s.admit(peer, time.Now()) {
		s.writeError(w, 429, "rate_limited", "Wait before opening another connection.")
		return
	}
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		s.writeError(w, 500, "internal_error", "A connection could not be created.")
		return
	}
	id := "c_" + hex.EncodeToString(bytes)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.mu.Lock()
	if s.stopping.Load() || len(s.connections) >= s.options.MaxConnections {
		s.mu.Unlock()
		s.writeError(w, 503, "capacity_reached", "The server has reached its connection limit.")
		return
	}
	s.connections[id] = cancel
	s.wg.Add(1)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.connections, id); s.mu.Unlock(); s.wg.Done() }()
	// WebSocket I/O uses per-operation contexts after the HTTP upgrade.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.options.AllowedOrigins, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4096)
	s.mu.Lock()
	s.connections[id] = func() { _ = conn.Close(websocket.StatusGoingAway, "server_shutdown"); cancel() }
	stopped := s.stopping.Load()
	s.mu.Unlock()
	if stopped {
		_ = conn.Close(websocket.StatusGoingAway, "server_shutdown")
		return
	}
	controls := make(chan delivery.Control, 32)
	readerDone := make(chan struct{})
	pingDone := make(chan struct{})
	go func() { defer close(readerDone); s.readControls(ctx, cancel, conn, controls) }()
	go func() { defer close(pingDone); pingPeer(ctx, cancel, conn) }()
	owner := delivery.NewConnection(id, s.market, socketSink{conn: conn, marketBudget: s.options.MarketFrameBudgetBytes}, delivery.ConnectionOptions{DebugControls: s.options.DebugControls, FeedReady: s.market.Ready})
	result := owner.Run(ctx, controls)
	slog.Info("connection closed", "connection", id, "code", result.Code, "reason", result.Reason)
	if s.stopping.Load() {
		result = delivery.CloseResult{Code: 1001, Reason: "server_shutdown"}
	}
	if result.Code == 1006 {
		_ = conn.CloseNow()
	} else {
		_ = conn.Close(websocket.StatusCode(result.Code), result.Reason)
	}
	cancel()
	<-readerDone
	<-pingDone
}

func (s *Server) readControls(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, out chan<- delivery.Control) {
	defer cancel()
	bucket := tokenBucket{tokens: 20, at: time.Now()}
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() == nil && websocket.CloseStatus(err) < 0 {
				slog.Warn("connection read ended", "error", err)
			}
			return
		}
		if !bucket.take(time.Now(), 20, 20) {
			_ = conn.Close(4008, "control_rate_limited")
			return
		}
		control := delivery.Control{Kind: "error", ErrorCode: "bad_message", ErrorMessage: "Send a valid protocol message."}
		if kind == websocket.MessageText {
			if decoded, err := wire.Decode("client", data); err == nil {
				control = decodeControl(decoded)
			} else {
				var header struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(data, &header) == nil && header.Type == "report" {
					select {
					case out <- delivery.Control{Kind: "invalid_report"}:
					case <-ctx.Done():
						return
					default:
						_ = conn.Close(4008, "control_queue_full")
						return
					}
				}
			}
		}
		select {
		case out <- control:
		case <-ctx.Done():
			return
		default:
			_ = conn.Close(4008, "control_queue_full")
			return
		}
	}
}

func decodeControl(value map[string]any) delivery.Control {
	c := delivery.Control{Kind: value["type"].(string), Session: value["session"].(string)}
	number := func(key string) float64 {
		if v, ok := value[key].(float64); ok {
			return v
		}
		return 0
	}
	switch c.Kind {
	case "subscribe":
		c.Subscription = delivery.SubscribeCommand{Interval: model.CandleInterval(value["interval"].(string)), RequestID: uint64(number("requestId"))}
	case "ping":
		c.ID = uint64(number("id"))
	case "report":
		c.LatencyMS, c.JitterMS, c.Samples = number("latencyMs"), number("jitterMs"), int(number("samples"))
	case "visibility":
		c.Hidden = value["hidden"].(bool)
	case "debug":
		c.Action = value["action"].(string)
		if text, ok := value["value"].(string); ok {
			c.Value = text
		}
		c.DelayMS = int(number("value"))
	}
	return c
}

func pingPeer(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, stop := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pingCtx)
			stop()
			if err != nil {
				cancel()
				_ = conn.CloseNow()
				return
			}
		}
	}
}
