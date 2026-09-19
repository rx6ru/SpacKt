package transport_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"spackt/internal/model"
	"spackt/internal/transport"
)

func TestHealthReadyAndAPIDuringMarketStartup(t *testing.T) {
	market := &lifecycleMarket{}
	ts, _ := newLifecycleTestServer(t, market)

	status, body := doLifecycleJSON(t, ts.URL+"/healthz")
	if status != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200; body=%#v", status, body)
	}
	if got := stringAt(t, body, "status"); got != "ok" {
		t.Fatalf("healthz status body = %q, want ok", got)
	}

	status, body = doLifecycleJSON(t, ts.URL+"/readyz")
	if status != http.StatusServiceUnavailable {
		t.Fatalf("readyz status = %d, want 503; body=%#v", status, body)
	}
	if got := stringAt(t, body, "status"); got != "not_ready" {
		t.Fatalf("readyz status body = %q, want not_ready", got)
	}

	status, body = doLifecycleJSON(t, ts.URL+"/api/meta")
	if status != http.StatusServiceUnavailable {
		t.Fatalf("api status = %d, want 503; body=%#v", status, body)
	}
	requireLifecycleErrorCode(t, body, "not_ready")
}

func TestReadinessReflectsMarketReadyTransitions(t *testing.T) {
	market := &lifecycleMarket{}
	ts, _ := newLifecycleTestServer(t, market)

	market.setReady(true)
	status, body := doLifecycleJSON(t, ts.URL+"/readyz")
	if status != http.StatusOK {
		t.Fatalf("readyz ready status = %d, want 200; body=%#v", status, body)
	}
	if got := stringAt(t, body, "status"); got != "ok" {
		t.Fatalf("readyz ready body = %q, want ok", got)
	}

	market.setReady(false)
	status, body = doLifecycleJSON(t, ts.URL+"/readyz")
	if status != http.StatusServiceUnavailable {
		t.Fatalf("readyz stalled status = %d, want 503; body=%#v", status, body)
	}
	if got := stringAt(t, body, "status"); got != "not_ready" {
		t.Fatalf("readyz stalled body = %q, want not_ready", got)
	}
}

func TestServerCloseFailsReadinessAndClosesAdmittedSocketWith1001(t *testing.T) {
	market := &lifecycleMarket{}
	market.setReady(true)
	ts, server := newLifecycleTestServer(t, market)
	conn := dialLifecycleWebSocket(t, ts)
	defer conn.CloseNow()
	_ = readLimitMessage(t, conn, 5*time.Second)

	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		done <- server.Close(ctx)
	}()

	status := readLimitCloseStatus(t, conn, 2*time.Second)
	if status != 1001 {
		t.Fatalf("close status = %d, want 1001", status)
	}
	if err := <-done; err != nil {
		t.Fatalf("Server.Close returned error: %v", err)
	}

	readyStatus, body := doLifecycleJSON(t, ts.URL+"/readyz")
	if readyStatus != http.StatusServiceUnavailable {
		t.Fatalf("readyz after Close status = %d, want 503; body=%#v", readyStatus, body)
	}
	if got := stringAt(t, body, "status"); got != "not_ready" {
		t.Fatalf("readyz after Close body = %q, want not_ready", got)
	}
}

func TestUnansweredProtocolPingReleasesConnectionCapacity(t *testing.T) {
	market := &lifecycleMarket{}
	market.setReady(true)
	ts, _ := newLifecycleTestServerWithOptions(t, market, transport.Options{
		AllowedOrigins:         []string{limitTestOrigin},
		MaxConnections:         1,
		MarketFrameBudgetBytes: 1 << 20,
		BookChanges:            4096,
	})

	rawConn := dialLifecycleRawSocket(t, ts)
	defer rawConn.Close(websocket.StatusNormalClosure, "test cleanup")

	start := time.Now()
	eventuallyDialLifecycleWebSocket(t, ts, 28*time.Second).CloseNow()
	elapsed := time.Since(start)
	if elapsed < 24*time.Second {
		t.Fatalf("connection capacity released after %s, want release only after protocol ping timeout", elapsed)
	}
}

type lifecycleMarket struct {
	ready atomic.Bool
}

func (m *lifecycleMarket) setReady(ready bool) {
	m.ready.Store(ready)
}

func (m *lifecycleMarket) Ready() bool {
	return m.ready.Load()
}

func (m *lifecycleMarket) Current() model.Publication {
	return model.Publication{
		Session:             "s1",
		Symbol:              "BTC-USD",
		MarketRev:           1,
		TimeMS:              1_700_000_000_000,
		Book:                model.BookSnapshot{Seq: 1},
		LatestPriceTicks:    100,
		ReferencePriceTicks: 100,
	}
}

func (m *lifecycleMarket) CaptureBook(context.Context) (model.BookCapture, error) {
	return model.BookCapture{Session: "s1", Symbol: "BTC-USD", TimeMS: 1_700_000_000_000, Book: model.BookSnapshot{Seq: 1}}, nil
}

func (m *lifecycleMarket) CaptureHistory(context.Context, model.CandleInterval, int) ([]model.Candle, error) {
	return nil, nil
}

func (m *lifecycleMarket) CaptureTrades(context.Context, int) ([]model.Trade, error) {
	return nil, nil
}

func newLifecycleTestServer(t *testing.T, market *lifecycleMarket) (*httptest.Server, *transport.Server) {
	t.Helper()
	return newLifecycleTestServerWithOptions(t, market, transport.Options{
		AllowedOrigins:         []string{limitTestOrigin},
		MaxConnections:         100,
		MarketFrameBudgetBytes: 1 << 20,
		BookChanges:            4096,
	})
}

func newLifecycleTestServerWithOptions(t *testing.T, market *lifecycleMarket, options transport.Options) (*httptest.Server, *transport.Server) {
	t.Helper()
	server, err := transport.NewServer(market, options)
	if err != nil {
		t.Fatalf("NewServer returned error: %v", err)
	}
	ts := httptest.NewServer(server)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Close(ctx)
		ts.Close()
	})
	return ts, server
}

func doLifecycleJSON(t *testing.T, rawURL string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do request: %v", err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return resp.StatusCode, decodeLimitObject(t, payload)
}

func requireLifecycleErrorCode(t *testing.T, body map[string]any, want string) {
	t.Helper()
	errObj, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("error envelope = %#v, want object", body["error"])
	}
	if got := stringAt(t, errObj, "code"); got != want {
		t.Fatalf("error code = %q, want %q in %#v", got, want, body)
	}
}

func dialLifecycleWebSocket(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, lifecycleWSURL(ts.URL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{limitTestOrigin}},
	})
	if err != nil {
		t.Fatalf("Dial status=%v error=%v", statusOf(resp), err)
	}
	return conn
}

func eventuallyDialLifecycleWebSocket(t *testing.T, ts *httptest.Server, within time.Duration) *websocket.Conn {
	t.Helper()
	deadline := time.Now().Add(within)
	var lastStatus int
	var lastErr error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		conn, resp, err := websocket.Dial(ctx, lifecycleWSURL(ts.URL), &websocket.DialOptions{
			HTTPHeader: http.Header{"Origin": []string{limitTestOrigin}},
		})
		cancel()
		if err == nil {
			return conn
		}
		lastStatus = statusOf(resp)
		lastErr = err
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("WebSocket capacity was not released within %s; last status=%d error=%v", within, lastStatus, lastErr)
	return nil
}

func dialLifecycleRawSocket(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, lifecycleWSURL(ts.URL), &websocket.DialOptions{
		HTTPHeader:      http.Header{"Origin": []string{limitTestOrigin}},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatalf("raw Dial status=%v error=%v", statusOf(resp), err)
	}
	return conn
}

func lifecycleWSURL(httpURL string) string {
	u, err := url.Parse(httpURL)
	if err != nil {
		panic(err)
	}
	u.Scheme = strings.Replace(u.Scheme, "http", "ws", 1)
	u.Path = "/ws"
	return u.String()
}
