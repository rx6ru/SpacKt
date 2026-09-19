package transport_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"spackt/internal/model"
	"spackt/internal/transport"
)

const limitTestOrigin = "http://localhost:3000"

func TestWebSocketMaxConnectionsRejectsAndReleasesCapacity(t *testing.T) {
	ts := newLimitTestServer(t, transport.Options{
		AllowedOrigins:         []string{limitTestOrigin},
		MaxConnections:         1,
		MarketFrameBudgetBytes: 1 << 20,
		BookChanges:            4096,
	})

	first := dialLimitWebSocket(t, ts)
	defer first.CloseNow()
	secondConn, secondResp, secondErr := dialLimitWebSocketRaw(t, ts)
	if secondConn != nil {
		secondConn.CloseNow()
	}
	if secondErr == nil {
		t.Fatal("second WebSocket dial succeeded, want capacity rejection")
	}
	if secondResp == nil || secondResp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("second dial status = %v, want 503", statusOf(secondResp))
	}
	assertLimitErrorCode(t, secondResp, "capacity_reached")

	first.CloseNow()
	eventuallyDialLimitWebSocket(t, ts, 2*time.Second).CloseNow()
}

func TestWebSocketAdmissionRejectsEleventhNewSocketFromSamePeer(t *testing.T) {
	ts := newLimitTestServer(t, transport.Options{
		AllowedOrigins:         []string{limitTestOrigin},
		MaxConnections:         100,
		MarketFrameBudgetBytes: 1 << 20,
		BookChanges:            4096,
	})
	var conns []*websocket.Conn
	defer func() {
		for _, conn := range conns {
			conn.CloseNow()
		}
	}()
	for i := 0; i < 10; i++ {
		conns = append(conns, dialLimitWebSocket(t, ts))
	}

	conn, resp, err := dialLimitWebSocketRaw(t, ts)
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil {
		t.Fatal("eleventh WebSocket dial succeeded, want admission rate limit")
	}
	if resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("eleventh dial status = %v, want 429", statusOf(resp))
	}
	assertLimitErrorCode(t, resp, "rate_limited")
}

func TestWebSocketInboundControlBurstClosesWith4008(t *testing.T) {
	ts := newLimitTestServer(t, transport.Options{
		AllowedOrigins:         []string{limitTestOrigin},
		MaxConnections:         100,
		MarketFrameBudgetBytes: 1 << 20,
		BookChanges:            4096,
	})
	conn := dialLimitWebSocket(t, ts)
	defer conn.CloseNow()
	hello := readLimitMessage(t, conn, 5*time.Second)
	session := stringAt(t, hello, "session")

	for i := 0; i < 21; i++ {
		writeLimitJSON(t, conn, map[string]any{
			"type":    "visibility",
			"session": session,
			"hidden":  false,
		})
	}

	status, reason := readLimitClose(t, conn, 5*time.Second)
	if status != 4008 {
		t.Fatalf("close status = %d, want 4008", status)
	}
	if reason != "control_rate_limited" {
		t.Fatalf("close reason = %q, want control_rate_limited", reason)
	}
}

type limitMarket struct{}

func (limitMarket) Ready() bool {
	return true
}

func (limitMarket) Current() model.Publication {
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

func (limitMarket) CaptureBook(context.Context) (model.BookCapture, error) {
	return model.BookCapture{Session: "s1", Symbol: "BTC-USD", TimeMS: 1_700_000_000_000, Book: model.BookSnapshot{Seq: 1}}, nil
}

func (limitMarket) CaptureHistory(context.Context, model.CandleInterval, int) ([]model.Candle, error) {
	return nil, nil
}

func (limitMarket) CaptureTrades(context.Context, int) ([]model.Trade, error) {
	return nil, nil
}

func newLimitTestServer(t *testing.T, options transport.Options) *httptest.Server {
	t.Helper()
	server, err := transport.NewServer(limitMarket{}, options)
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
	return ts
}

func dialLimitWebSocket(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	conn, resp, err := dialLimitWebSocketRaw(t, ts)
	if err != nil {
		t.Fatalf("Dial status=%v error=%v", statusOf(resp), err)
	}
	return conn
}

func eventuallyDialLimitWebSocket(t *testing.T, ts *httptest.Server, within time.Duration) *websocket.Conn {
	t.Helper()
	deadline := time.Now().Add(within)
	var lastStatus int
	var lastErr error
	for time.Now().Before(deadline) {
		conn, resp, err := dialLimitWebSocketRaw(t, ts)
		if err == nil {
			return conn
		}
		lastStatus = statusOf(resp)
		lastErr = err
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("WebSocket capacity was not released within %s; last status=%d error=%v", within, lastStatus, lastErr)
	return nil
}

func dialLimitWebSocketRaw(t *testing.T, ts *httptest.Server) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, limitWSURL(ts.URL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{limitTestOrigin}},
	})
}

func limitWSURL(httpURL string) string {
	u, err := url.Parse(httpURL)
	if err != nil {
		panic(err)
	}
	u.Scheme = strings.Replace(u.Scheme, "http", "ws", 1)
	u.Path = "/ws"
	return u.String()
}

func readLimitMessage(t *testing.T, conn *websocket.Conn, within time.Duration) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	typ, payload, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("Read error = %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("message type = %v, want text", typ)
	}
	return decodeLimitObject(t, payload)
}

func readLimitCloseStatus(t *testing.T, conn *websocket.Conn, within time.Duration) int {
	t.Helper()
	status, _ := readLimitClose(t, conn, within)
	return status
}

func readLimitClose(t *testing.T, conn *websocket.Conn, within time.Duration) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	for {
		_, _, err := conn.Read(ctx)
		if err == nil {
			continue
		}
		status := websocket.CloseStatus(err)
		if status == -1 {
			t.Fatalf("Read error without close status: %v", err)
		}
		var closeErr websocket.CloseError
		if !errors.As(err, &closeErr) {
			t.Fatalf("Read error = %v, want CloseError", err)
		}
		return int(status), closeErr.Reason
	}
}

func writeLimitJSON(t *testing.T, conn *websocket.Conn, value map[string]any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal JSON: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("Write JSON: %v", err)
	}
}

func assertLimitErrorCode(t *testing.T, resp *http.Response, want string) {
	t.Helper()
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		t.Fatalf("read error body: %v", err)
	}
	msg := decodeLimitObject(t, body)
	errObj, ok := msg["error"].(map[string]any)
	if !ok {
		t.Fatalf("error envelope = %#v, want object", msg["error"])
	}
	if got := stringAt(t, errObj, "code"); got != want {
		t.Fatalf("error code = %q, want %q; body=%s", got, want, body)
	}
}

func decodeLimitObject(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		t.Fatalf("decode JSON %s: %v", payload, err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		t.Fatalf("extra JSON content in %s", payload)
	}
	return body
}

func stringAt(t *testing.T, values map[string]any, key string) string {
	t.Helper()
	value, ok := values[key].(string)
	if !ok {
		t.Fatalf("%s = %T, want string in %#v", key, values[key], values)
	}
	return value
}

func statusOf(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}
