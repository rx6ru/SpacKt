package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const (
	allowedOrigin = "http://localhost:3000"
	deniedOrigin  = "https://evil.example"
)

type testServer struct {
	app *App
	srv *httptest.Server
}

func newTestServer(t *testing.T, mutate func(*Config)) *testServer {
	t.Helper()

	cfg := Config{
		Seed:                   7,
		EpochMS:                1700000000000,
		HistoryMinutes:         6,
		AllowedOrigins:         []string{allowedOrigin},
		DebugControls:          true,
		MaxConnections:         16,
		MarketFrameBudgetBytes: 1 << 20,
		BookChanges:            4096,
	}
	if mutate != nil {
		mutate(&cfg)
	}

	app, err := NewApp(cfg)
	if err != nil {
		t.Fatalf("NewApp() error = %v", err)
	}

	ts := &testServer{
		app: app,
		srv: httptest.NewServer(app.Handler()),
	}
	t.Cleanup(func() {
		ts.srv.Close()
		if err := ts.app.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	return ts
}

func TestHealthzReturnsOk(t *testing.T) {
	ts := newTestServer(t, func(cfg *Config) {
		cfg.HistoryMinutes = 60
	})

	status, body, _ := doJSON(t, http.MethodGet, ts.srv.URL+"/healthz", "", nil)

	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	assertString(t, body, "status", "ok")
}

func TestReadyzEventuallyReturnsOkAfterInitialization(t *testing.T) {
	ts := newTestServer(t, nil)

	body := waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	assertString(t, body, "status", "ok")
}

func TestMetaEndpointReturnsCompletePublicSchema(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, header := doJSON(t, http.MethodGet, ts.srv.URL+"/api/meta", "", nil)

	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	assertNoStore(t, header)
	assertSessionSymbol(t, body)
	assertString(t, body, "tickSize", "0.01")
	assertString(t, body, "lotSize", "0.0001")
	assertString(t, body, "referencePrice", "")
	assertStringSlice(t, body, "intervals", []string{"1s", "1m", "5m"})
	tierPolicy := objectAt(t, body, "tierPolicy")
	retention := objectAt(t, body, "retention")
	assertObjectKeys(t, tierPolicy,
		"downgradeDwellMs",
		"enterDegraded",
		"enterMinimal",
		"flushMs",
		"hiddenCloseMs",
		"initialTier",
		"minimumReportSamples",
		"missingReportMinimalMs",
		"missingReportStepMs",
		"pingEveryMs",
		"pongTimeoutMs",
		"recoverDegraded",
		"recoverFull",
		"reportEveryMs",
		"rttWindowSamples",
		"upgradeDwellMs",
	)
	assertString(t, tierPolicy, "initialTier", "degraded")
	flushMs := objectAt(t, tierPolicy, "flushMs")
	assertObjectKeys(t, flushMs, "degraded", "full", "minimal")
	assertNumberEquals(t, flushMs, "full", 100)
	assertNumberEquals(t, flushMs, "degraded", 500)
	assertNumberEquals(t, flushMs, "minimal", 2000)
	enterDegraded := objectAt(t, tierPolicy, "enterDegraded")
	assertObjectKeys(t, enterDegraded, "jitterAboveMs", "latencyAboveMs")
	assertNumberEquals(t, enterDegraded, "latencyAboveMs", 400)
	assertNumberEquals(t, enterDegraded, "jitterAboveMs", 60)
	enterMinimal := objectAt(t, tierPolicy, "enterMinimal")
	assertObjectKeys(t, enterMinimal, "jitterAboveMs", "latencyAboveMs")
	assertNumberEquals(t, enterMinimal, "latencyAboveMs", 900)
	assertNumberEquals(t, enterMinimal, "jitterAboveMs", 150)
	recoverFull := objectAt(t, tierPolicy, "recoverFull")
	assertObjectKeys(t, recoverFull, "jitterBelowMs", "latencyBelowMs")
	assertNumberEquals(t, recoverFull, "latencyBelowMs", 300)
	assertNumberEquals(t, recoverFull, "jitterBelowMs", 40)
	recoverDegraded := objectAt(t, tierPolicy, "recoverDegraded")
	assertObjectKeys(t, recoverDegraded, "jitterBelowMs", "latencyBelowMs")
	assertNumberEquals(t, recoverDegraded, "latencyBelowMs", 700)
	assertNumberEquals(t, recoverDegraded, "jitterBelowMs", 100)
	assertNumberEquals(t, tierPolicy, "downgradeDwellMs", 3000)
	assertNumberEquals(t, tierPolicy, "upgradeDwellMs", 10000)
	assertNumberEquals(t, tierPolicy, "missingReportStepMs", 5000)
	assertNumberEquals(t, tierPolicy, "missingReportMinimalMs", 12000)
	assertNumberEquals(t, tierPolicy, "pingEveryMs", 1000)
	assertNumberEquals(t, tierPolicy, "pongTimeoutMs", 3000)
	assertNumberEquals(t, tierPolicy, "reportEveryMs", 2000)
	assertNumberEquals(t, tierPolicy, "rttWindowSamples", 10)
	assertNumberEquals(t, tierPolicy, "minimumReportSamples", 2)
	assertNumberEquals(t, tierPolicy, "hiddenCloseMs", 180000)
	assertObjectKeys(t, retention, "bookChanges", "deliveryClosedCandles", "historyCandles", "maximumBookLevelsPerSide", "recentTrades")
	historyCandles := objectAt(t, retention, "historyCandles")
	assertObjectKeys(t, historyCandles, "1m", "1s", "5m")
	assertNumberEquals(t, historyCandles, "1s", 3600)
	assertNumberEquals(t, historyCandles, "1m", 1440)
	assertNumberEquals(t, historyCandles, "5m", 2016)
	assertNumberEquals(t, retention, "deliveryClosedCandles", 64)
	assertNumberEquals(t, retention, "recentTrades", 200)
	assertNumberEquals(t, retention, "bookChanges", 4096)
	assertNumberEquals(t, retention, "maximumBookLevelsPerSide", 50)
}

func TestBookEndpointReturnsConsistentSnapshot(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, header := doJSON(t, http.MethodGet, ts.srv.URL+"/api/book", "", nil)

	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	assertNoStore(t, header)
	assertSessionSymbol(t, body)
	assertSafeUint(t, body, "seq")
	assertSafeUint(t, body, "t")
	assertLevels(t, body["bids"], true)
	assertLevels(t, body["asks"], false)
}

func TestHistoryEndpointReturnsAscendingCandles(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, header := doJSON(t, http.MethodGet, ts.srv.URL+"/api/candles?interval=1s&limit=20&requestId=3", "", nil)

	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	assertNoStore(t, header)
	assertSessionSymbol(t, body)
	assertString(t, body, "interval", "1s")
	assertNumberEquals(t, body, "requestId", 3)
	assertCandlesAscending(t, arrayAt(t, body, "candles"), "1s")
}

func TestTradesEndpointReturnsNewestTradesFirst(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, header := doJSON(t, http.MethodGet, ts.srv.URL+"/api/trades?limit=25", "", nil)

	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	assertNoStore(t, header)
	assertSessionSymbol(t, body)
	trades := arrayAt(t, body, "trades")
	var last int64 = 1<<63 - 1
	for i, raw := range trades {
		trade := asObject(t, raw)
		id := int64At(t, trade, "id")
		if id >= last {
			t.Fatalf("trade %d id = %d, previous id = %d; want newest first", i, id, last)
		}
		last = id
		assertTrade(t, trade)
	}
}

func TestCandlesEndpointRejectsUnknownInterval(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, header := doJSON(t, http.MethodGet, ts.srv.URL+"/api/candles?interval=2m", "", nil)

	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", status, body)
	}
	assertNoStore(t, header)
	assertErrorCode(t, body, "bad_request")
}

func TestCandlesEndpointRejectsDuplicateLimitParameter(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, _ := doJSON(t, http.MethodGet, ts.srv.URL+"/api/candles?interval=1s&limit=10&limit=11", "", nil)

	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", status, body)
	}
	assertErrorCode(t, body, "bad_request")
}

func TestUnknownAPIRouteReturnsNotFoundEnvelope(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, header := doJSON(t, http.MethodGet, ts.srv.URL+"/api/nope", "", nil)

	if status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", status, body)
	}
	assertNoStore(t, header)
	assertErrorCode(t, body, "not_found")
}

func TestUnsupportedMethodReturnsAllowHeader(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, header := doJSON(t, http.MethodPost, ts.srv.URL+"/api/book", "", nil)

	if status != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405; body=%s", status, body)
	}
	assertNoStore(t, header)
	assertErrorCode(t, body, "method_not_allowed")
	if got := header.Get("Allow"); got != "GET, OPTIONS" {
		t.Fatalf("Allow = %q, want %q", got, "GET, OPTIONS")
	}
}

func TestRESTAllowsConfiguredOriginWithoutCredentials(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, header := doJSON(t, http.MethodGet, ts.srv.URL+"/api/meta", allowedOrigin, nil)

	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if got := header.Get("Access-Control-Allow-Origin"); got != allowedOrigin {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, allowedOrigin)
	}
	if got := header.Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want absent", got)
	}
	assertVaryIncludes(t, header, "Origin")
}

func TestRESTDeniesUnconfiguredOrigin(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	status, body, header := doJSON(t, http.MethodGet, ts.srv.URL+"/api/meta", deniedOrigin, nil)

	if status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body=%s", status, body)
	}
	if got := header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want absent", got)
	}
	assertErrorCode(t, body, "origin_denied")
}

func TestRESTPreflightAllowsGETWithAcceptHeader(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	resp := doPreflight(t, ts.srv.URL+"/api/meta", http.MethodGet, "Accept")
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != allowedOrigin {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, allowedOrigin)
	}
	if got := resp.Header.Get("Access-Control-Allow-Methods"); got != http.MethodGet {
		t.Fatalf("Access-Control-Allow-Methods = %q, want %q", got, http.MethodGet)
	}
	if got := resp.Header.Get("Access-Control-Allow-Headers"); got != "Accept" {
		t.Fatalf("Access-Control-Allow-Headers = %q, want Accept", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want absent", got)
	}
	assertVaryIncludes(t, resp.Header, "Origin")
	assertVaryIncludes(t, resp.Header, "Access-Control-Request-Method")
	assertVaryIncludes(t, resp.Header, "Access-Control-Request-Headers")
}

func TestRESTPreflightDeniesPOST(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	resp := doPreflight(t, ts.srv.URL+"/api/meta", http.MethodPost, "Accept")
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

func TestRESTPreflightDeniesNonAcceptHeader(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	resp := doPreflight(t, ts.srv.URL+"/api/meta", http.MethodGet, "Content-Type")
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

func TestWebSocketDeniedOriginDoesNotUpgrade(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, wsURL(ts.srv.URL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{deniedOrigin}},
	})
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil {
		t.Fatal("Dial with denied Origin succeeded, want rejection")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("upgrade status = %v, want 403", statusOf(resp))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read upgrade rejection body: %v", err)
	}
	assertErrorCode(t, decodeObject(t, body), "origin_denied")
}

func TestWebSocketMissingOriginDoesNotUpgrade(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, wsURL(ts.srv.URL), &websocket.DialOptions{})
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil {
		t.Fatal("Dial without Origin succeeded, want rejection")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("upgrade status = %v, want 403", statusOf(resp))
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		t.Fatalf("read upgrade rejection body: %v", readErr)
	}
	assertErrorCode(t, decodeObject(t, body), "origin_denied")
}

func TestWebSocketHelloIncludesProtocolSessionTierAndFlush(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	assertNumberEquals(t, hello, "v", 1)
	assertSessionSymbol(t, hello)
	assertString(t, hello, "connId", "")
	assertString(t, hello, "tier", "degraded")
	assertString(t, hello, "autoTier", "degraded")
	assertBool(t, hello, "hidden", false)
	assertSafeUint(t, hello, "flushMs")
}

func TestWebSocketSubscribeEchoesRequestIDAndSendsSeed(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	writeJSON(t, conn, map[string]any{
		"type":      "subscribe",
		"session":   hello["session"],
		"interval":  "1s",
		"requestId": 1,
	})
	sub := readTyped(t, conn, "subscribed", 5*time.Second)
	assertNumberEquals(t, sub, "requestId", 1)
	assertString(t, sub, "interval", "1s")

	update := readUntil(t, conn, 5*time.Second, func(msg map[string]any) bool {
		candles, ok := msg["candles"].(map[string]any)
		if !ok {
			return false
		}
		return int64At(t, candles, "requestId") == 1
	})
	candles := objectAt(t, update, "candles")
	assertString(t, candles, "interval", "1s")
	assertCandlesAscending(t, arrayAt(t, candles, "items"), "1s")
}

func TestWebSocketPingEchoesID(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	writeJSON(t, conn, map[string]any{"type": "ping", "session": hello["session"], "id": 33})
	pong := readTyped(t, conn, "pong", 5*time.Second)

	assertNumberEquals(t, pong, "id", 33)
}

func TestWebSocketRejectsWrongSessionMessageAndStaysOpen(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	writeJSON(t, conn, map[string]any{"type": "ping", "session": "wrong-session", "id": 40})
	errMsg := readTyped(t, conn, "error", 5*time.Second)
	assertString(t, errMsg, "code", "wrong_session")

	writeJSON(t, conn, map[string]any{"type": "ping", "session": hello["session"], "id": 41})
	pong := readTyped(t, conn, "pong", 5*time.Second)
	assertNumberEquals(t, pong, "id", 41)
}

func TestDebugForceTierAffectsOnlyCaller(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	a := dialWS(t, ts)
	defer a.CloseNow()
	aHello := readTyped(t, a, "hello", 5*time.Second)
	b := dialWS(t, ts)
	defer b.CloseNow()
	bHello := readTyped(t, b, "hello", 5*time.Second)

	writeJSON(t, a, map[string]any{
		"type":    "debug",
		"session": aHello["session"],
		"action":  "forceTier",
		"value":   "minimal",
	})

	aTier := readUntil(t, a, 5*time.Second, func(msg map[string]any) bool {
		return msg["type"] == "tier" && msg["forced"] == "minimal"
	})
	assertString(t, aTier, "tier", "minimal")

	writeJSON(t, b, map[string]any{"type": "ping", "session": bHello["session"], "id": 44})
	pong := readTyped(t, b, "pong", 5*time.Second)
	assertNumberEquals(t, pong, "id", 44)
	assertNoTierBeforePong(t, b, "minimal")
}

func TestTwoClientsUseIndependentTierRatesAndPreserveClosedCandles(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	full := dialWS(t, ts)
	defer full.CloseNow()
	fullHello := readTyped(t, full, "hello", 5*time.Second)
	slow := dialWS(t, ts)
	defer slow.CloseNow()
	slowHello := readTyped(t, slow, "hello", 5*time.Second)

	writeJSON(t, full, map[string]any{"type": "debug", "session": fullHello["session"], "action": "forceTier", "value": "full"})
	fullTier := readUntil(t, full, 5*time.Second, func(msg map[string]any) bool {
		return msg["type"] == "tier" && msg["forced"] == "full"
	})
	assertString(t, fullTier, "tier", "full")
	writeJSON(t, slow, map[string]any{"type": "debug", "session": slowHello["session"], "action": "forceTier", "value": "minimal"})
	slowTier := readUntil(t, slow, 5*time.Second, func(msg map[string]any) bool {
		return msg["type"] == "tier" && msg["forced"] == "minimal"
	})
	assertString(t, slowTier, "tier", "minimal")

	writeJSON(t, full, map[string]any{"type": "subscribe", "session": fullHello["session"], "interval": "1s", "requestId": 1})
	_ = readTyped(t, full, "subscribed", 5*time.Second)
	writeJSON(t, slow, map[string]any{"type": "subscribe", "session": slowHello["session"], "interval": "1s", "requestId": 1})
	_ = readTyped(t, slow, "subscribed", 5*time.Second)

	fullBatches, slowBatches := collectCandleBatchesFromBoth(t, full, slow, 4500*time.Millisecond, 1)
	if len(fullBatches) <= len(slowBatches) {
		t.Fatalf("full client candle batches = %d, minimal client batches = %d; want full to receive more chart updates", len(fullBatches), len(slowBatches))
	}
	assertClosedCandleContinuity(t, flattenClosedCandles(t, slowBatches), "1s")
	assertOverlappedClosedCandlesMatch(t, flattenClosedCandles(t, fullBatches), flattenClosedCandles(t, slowBatches))
}

func TestDebugDisconnectClosesWith4003(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	writeJSON(t, conn, map[string]any{"type": "debug", "session": hello["session"], "action": "disconnect"})

	if got := readCloseStatus(t, conn, 5*time.Second); got != 4003 {
		t.Fatalf("debug disconnect close status = %d, want 4003", got)
	}
}

func TestOversizedInboundWebSocketMessageClosesWith1009(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	_ = readTyped(t, conn, "hello", 5*time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := conn.Write(ctx, websocket.MessageText, bytes.Repeat([]byte("x"), 4097))
	if err != nil && websocket.CloseStatus(err) == -1 {
		t.Fatalf("write oversized frame: %v", err)
	}
	_, _, err = conn.Read(ctx)
	if err == nil {
		t.Fatal("Read succeeded after oversized frame, want close")
	}
	if got := websocket.CloseStatus(err); got != websocket.StatusMessageTooBig {
		t.Fatalf("close status = %d, want 1009; err=%v", got, err)
	}
}

func TestInvalidJSONReturnsSafeErrorAndConnectionStaysOpen(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	writeText(t, conn, []byte(`{"type":"ping","session":`))
	errMsg := readTyped(t, conn, "error", 5*time.Second)
	assertString(t, errMsg, "code", "bad_message")

	writeJSON(t, conn, map[string]any{"type": "ping", "session": hello["session"], "id": 55})
	pong := readTyped(t, conn, "pong", 5*time.Second)
	assertNumberEquals(t, pong, "id", 55)
}

func TestSubscribeRejectsOlderRequestID(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	writeJSON(t, conn, map[string]any{"type": "subscribe", "session": hello["session"], "interval": "1s", "requestId": 2})
	sub := readTyped(t, conn, "subscribed", 5*time.Second)
	assertNumberEquals(t, sub, "requestId", 2)

	writeJSON(t, conn, map[string]any{"type": "subscribe", "session": hello["session"], "interval": "1m", "requestId": 1})
	errMsg := readTyped(t, conn, "error", 5*time.Second)
	assertString(t, errMsg, "code", "bad_request_id")
}

func TestSubscribeDoesNotEmitOldCandlePayloadAfterNewAcknowledgement(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	writeJSON(t, conn, map[string]any{"type": "subscribe", "session": hello["session"], "interval": "1s", "requestId": 1})
	_ = readTyped(t, conn, "subscribed", 5*time.Second)
	firstA := readUntil(t, conn, 5*time.Second, func(msg map[string]any) bool {
		candles, ok := msg["candles"].(map[string]any)
		return ok && int64At(t, candles, "requestId") == 1
	})
	assertString(t, objectAt(t, firstA, "candles"), "interval", "1s")

	writeJSON(t, conn, map[string]any{"type": "subscribe", "session": hello["session"], "interval": "1m", "requestId": 2})
	sub2 := readTyped(t, conn, "subscribed", 5*time.Second)
	assertNumberEquals(t, sub2, "requestId", 2)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		msg, ok := readOptional(t, conn, time.Until(deadline))
		if !ok {
			return
		}
		if candles, ok := msg["candles"].(map[string]any); ok {
			if got := int64At(t, candles, "requestId"); got == 1 {
				t.Fatalf("received obsolete candle payload after request 2 ack: %#v", msg)
			}
		}
	}
}

func TestTinyMarketFrameBudgetClosesBeforeAnyMarketUpdate(t *testing.T) {
	ts := newTestServer(t, func(cfg *Config) {
		cfg.MarketFrameBudgetBytes = 128
	})
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	writeJSON(t, conn, map[string]any{"type": "ping", "session": hello["session"], "id": 90})
	pong := readTyped(t, conn, "pong", 5*time.Second)
	assertNumberEquals(t, pong, "id", 90)

	writeJSON(t, conn, map[string]any{"type": "subscribe", "session": hello["session"], "interval": "1s", "requestId": 1})
	_ = readTyped(t, conn, "subscribed", 5*time.Second)

	deadline := time.Now().Add(5 * time.Second)
	for {
		msg, status, closed := readObjectOrClose(t, conn, time.Until(deadline))
		if closed {
			if status != 4009 {
				t.Fatalf("close status = %d, want 4009", status)
			}
			return
		}
		if msg["type"] == "update" {
			t.Fatalf("received market update before 4009 payload_too_large close: %#v", msg)
		}
	}
}

func TestSmallBookChangeRetentionSendsResetAndResumesRanges(t *testing.T) {
	ts := newTestServer(t, func(cfg *Config) {
		cfg.BookChanges = 4
	})
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)
	writeJSON(t, conn, map[string]any{"type": "subscribe", "session": hello["session"], "interval": "1s", "requestId": 1})
	_ = readTyped(t, conn, "subscribed", 5*time.Second)

	reset := readTyped(t, conn, "book_reset", 5*time.Second)
	assertString(t, reset, "reason", "cursor_expired")

	writeJSON(t, conn, map[string]any{"type": "debug", "session": hello["session"], "action": "forceTier", "value": "full"})
	tier := readUntil(t, conn, 5*time.Second, func(msg map[string]any) bool {
		return msg["type"] == "tier" && msg["forced"] == "full"
	})
	assertString(t, tier, "tier", "full")

	rangeMsg := readUntil(t, conn, 5*time.Second, hasBookRange)
	book := objectAt(t, rangeMsg, "book")
	if gotFrom, gotTo := int64At(t, book, "from"), int64At(t, book, "to"); gotFrom > gotTo {
		t.Fatalf("resumed book range from = %d, to = %d; want valid range after reset", gotFrom, gotTo)
	}
}

func TestDebugDropNextBookDeltaCreatesObservableGap(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)
	before := readUntil(t, conn, 5*time.Second, hasBookRange)
	beforeBook := objectAt(t, before, "book")
	beforeTo := int64At(t, beforeBook, "to")

	writeJSON(t, conn, map[string]any{"type": "debug", "session": hello["session"], "action": "dropNextBookDelta"})

	after := readUntil(t, conn, 5*time.Second, func(msg map[string]any) bool {
		book, ok := msg["book"].(map[string]any)
		return ok && int64At(t, book, "from") > beforeTo+1
	})
	afterBook := objectAt(t, after, "book")
	if got := int64At(t, afterBook, "from"); got <= beforeTo+1 {
		t.Fatalf("next book range from = %d after prior to = %d, want a real gap", got, beforeTo)
	}
}

func TestExpiredInitialBookCursorRequiresFreshSnapshotRecovery(t *testing.T) {
	ts := newTestServer(t, nil)
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	status, staleSnapshot, _ := doJSON(t, http.MethodGet, ts.srv.URL+"/api/book", "", nil)
	if status != http.StatusOK {
		t.Fatalf("book status = %d, want 200; body=%s", status, staleSnapshot)
	}
	if hello["session"] != staleSnapshot["session"] {
		t.Fatalf("hello session = %v, snapshot session = %v", hello["session"], staleSnapshot["session"])
	}

	reset := readTyped(t, conn, "book_reset", 5*time.Second)
	assertString(t, reset, "reason", "cursor_expired")
	if reset["session"] != hello["session"] {
		t.Fatalf("reset session = %v, hello session = %v", reset["session"], hello["session"])
	}

	status, freshSnapshot, _ := doJSON(t, http.MethodGet, ts.srv.URL+"/api/book", "", nil)
	if status != http.StatusOK {
		t.Fatalf("fresh book status = %d, want 200; body=%s", status, freshSnapshot)
	}
	if freshSnapshot["session"] != hello["session"] {
		t.Fatalf("fresh snapshot session = %v, hello session = %v", freshSnapshot["session"], hello["session"])
	}
	if int64At(t, freshSnapshot, "seq") < int64At(t, staleSnapshot, "seq") {
		t.Fatalf("fresh snapshot seq = %d, stale seq = %d", int64At(t, freshSnapshot, "seq"), int64At(t, staleSnapshot, "seq"))
	}
	freshSeq := int64At(t, freshSnapshot, "seq")
	rangeMsg := readUntil(t, conn, 5*time.Second, func(msg map[string]any) bool {
		book, ok := msg["book"].(map[string]any)
		return ok && int64At(t, book, "to") >= freshSeq+1
	})
	book := objectAt(t, rangeMsg, "book")
	if from, to := int64At(t, book, "from"), int64At(t, book, "to"); from > freshSeq+1 || to < freshSeq+1 {
		t.Fatalf("resumed book range = %d..%d, fresh seq = %d; want coverage of freshSeq+1", from, to, freshSeq)
	}
	if rangeMsg["session"] != freshSnapshot["session"] {
		t.Fatalf("range session = %v, fresh snapshot session = %v", rangeMsg["session"], freshSnapshot["session"])
	}
}

func TestFreshSnapshotAndBufferedWebSocketRangeUseSameSession(t *testing.T) {
	ts := newTestServer(t, func(cfg *Config) {
		cfg.HistoryMinutes = 1
	})
	waitForStatus(t, ts.srv.URL+"/readyz", http.StatusOK)

	conn := dialWS(t, ts)
	defer conn.CloseNow()
	hello := readTyped(t, conn, "hello", 5*time.Second)

	status, snapshot, _ := doJSON(t, http.MethodGet, ts.srv.URL+"/api/book", "", nil)
	if status != http.StatusOK {
		t.Fatalf("book status = %d, want 200; body=%s", status, snapshot)
	}
	if hello["session"] != snapshot["session"] {
		t.Fatalf("hello session = %v, snapshot session = %v", hello["session"], snapshot["session"])
	}
	snapshotSeq := int64At(t, snapshot, "seq")
	rangeMsg := readUntil(t, conn, 5*time.Second, func(msg map[string]any) bool {
		book, ok := msg["book"].(map[string]any)
		return ok && int64At(t, book, "to") >= snapshotSeq+1
	})
	book := objectAt(t, rangeMsg, "book")
	if from := int64At(t, book, "from"); from > snapshotSeq+1 {
		t.Fatalf("buffered range from = %d, snapshot seq = %d; want replayable coverage", from, snapshotSeq)
	}
	if rangeMsg["session"] != snapshot["session"] {
		t.Fatalf("range session = %v, snapshot session = %v", rangeMsg["session"], snapshot["session"])
	}
}

func TestSeededStartupExposesDeterministicReferencePrice(t *testing.T) {
	left := newTestServer(t, nil)
	right := newTestServer(t, nil)
	waitForStatus(t, left.srv.URL+"/readyz", http.StatusOK)
	waitForStatus(t, right.srv.URL+"/readyz", http.StatusOK)

	_, leftMeta, _ := doJSON(t, http.MethodGet, left.srv.URL+"/api/meta", "", nil)
	_, rightMeta, _ := doJSON(t, http.MethodGet, right.srv.URL+"/api/meta", "", nil)

	if leftMeta["referencePrice"] != rightMeta["referencePrice"] {
		t.Fatalf("same seed and epoch produced reference prices %v and %v", leftMeta["referencePrice"], rightMeta["referencePrice"])
	}
}

func doJSON(t *testing.T, method, rawURL, origin string, body io.Reader) (int, map[string]any, http.Header) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) == 0 {
		return resp.StatusCode, map[string]any{}, resp.Header.Clone()
	}
	return resp.StatusCode, decodeObject(t, payload), resp.Header.Clone()
}

func doPreflight(t *testing.T, rawURL, requestMethod, requestHeaders string) *http.Response {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodOptions, rawURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", allowedOrigin)
	req.Header.Set("Access-Control-Request-Method", requestMethod)
	req.Header.Set("Access-Control-Request-Headers", requestHeaders)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func waitForStatus(t *testing.T, rawURL string, want int) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var lastStatus int
	var lastBody map[string]any
	for time.Now().Before(deadline) {
		status, body, _ := doJSON(t, http.MethodGet, rawURL, "", nil)
		lastStatus = status
		lastBody = body
		if status == want {
			return body
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("%s never returned %d; last status=%d body=%s", rawURL, want, lastStatus, mustJSON(lastBody))
	return nil
}

func dialWS(t *testing.T, ts *testServer) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, wsURL(ts.srv.URL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{allowedOrigin}},
	})
	if err != nil {
		t.Fatalf("Dial status=%v error=%v", statusOf(resp), err)
	}
	conn.SetReadLimit(1 << 20)
	return conn
}

func wsURL(httpURL string) string {
	u, err := url.Parse(httpURL)
	if err != nil {
		panic(err)
	}
	u.Scheme = strings.Replace(u.Scheme, "http", "ws", 1)
	u.Path = "/ws"
	return u.String()
}

func writeJSON(t *testing.T, conn *websocket.Conn, value map[string]any) {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	writeText(t, conn, payload)
}

func writeText(t *testing.T, conn *websocket.Conn, payload []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("Write(%s) error = %v", payload, err)
	}
}

func readTyped(t *testing.T, conn *websocket.Conn, typ string, within time.Duration) map[string]any {
	t.Helper()
	return readUntil(t, conn, within, func(msg map[string]any) bool {
		return msg["type"] == typ
	})
}

func readUntil(t *testing.T, conn *websocket.Conn, within time.Duration, accept func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for WebSocket message", within)
		}
		msg, ok := readOptional(t, conn, time.Until(deadline))
		if !ok {
			t.Fatalf("timed out after %s waiting for WebSocket message", within)
		}
		assertString(t, msg, "session", "")
		if accept(msg) {
			return msg
		}
	}
}

func readOptional(t *testing.T, conn *websocket.Conn, within time.Duration) (map[string]any, bool) {
	t.Helper()
	if within <= 0 {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	typ, payload, err := conn.Read(ctx)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(context.Cause(ctx), context.DeadlineExceeded) {
			return nil, false
		}
		t.Fatalf("Read error = %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("message type = %v, want text", typ)
	}
	return decodeObject(t, payload), true
}

func readObjectOrClose(t *testing.T, conn *websocket.Conn, within time.Duration) (map[string]any, int, bool) {
	t.Helper()
	if within <= 0 {
		t.Fatal("timed out waiting for WebSocket message or close")
	}
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	typ, payload, err := conn.Read(ctx)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(context.Cause(ctx), context.DeadlineExceeded) {
			t.Fatal("timed out waiting for WebSocket message or close")
		}
		status := websocket.CloseStatus(err)
		if status == -1 {
			t.Fatalf("Read error without WebSocket close status: %v", err)
		}
		return nil, int(status), true
	}
	if typ != websocket.MessageText {
		t.Fatalf("message type = %v, want text", typ)
	}
	msg := decodeObject(t, payload)
	assertString(t, msg, "session", "")
	return msg, 0, false
}

func readCloseStatus(t *testing.T, conn *websocket.Conn, within time.Duration) int {
	t.Helper()
	_, status, closed := readObjectOrClose(t, conn, within)
	if !closed {
		t.Fatal("received WebSocket message, want close")
	}
	return status
}

func decodeObject(t *testing.T, payload []byte) map[string]any {
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

func collectCandleBatches(t *testing.T, conn *websocket.Conn, within time.Duration, requestID int64) [][]map[string]any {
	t.Helper()
	deadline := time.Now().Add(within)
	var batches [][]map[string]any
	for time.Now().Before(deadline) {
		msg, ok := readOptional(t, conn, time.Until(deadline))
		if !ok {
			break
		}
		candles, ok := msg["candles"].(map[string]any)
		if !ok {
			continue
		}
		if int64At(t, candles, "requestId") != requestID {
			continue
		}
		assertString(t, candles, "interval", "1s")
		rawItems := arrayAt(t, candles, "items")
		items := make([]map[string]any, 0, len(rawItems))
		for _, raw := range rawItems {
			items = append(items, asObject(t, raw))
		}
		batches = append(batches, items)
	}
	if len(batches) == 0 {
		t.Fatalf("received no candle batches for requestId %d in %s", requestID, within)
	}
	return batches
}

func collectCandleBatchesFromBoth(t *testing.T, left, right *websocket.Conn, within time.Duration, requestID int64) ([][]map[string]any, [][]map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()

	leftMessages, leftErrs := startMessagePump(ctx, left)
	rightMessages, rightErrs := startMessagePump(ctx, right)
	var leftBatches [][]map[string]any
	var rightBatches [][]map[string]any
	for {
		select {
		case msg := <-leftMessages:
			leftBatches = appendCandleBatch(t, leftBatches, msg, requestID)
		case msg := <-rightMessages:
			rightBatches = appendCandleBatch(t, rightBatches, msg, requestID)
		case err := <-leftErrs:
			if ctx.Err() == nil {
				t.Fatalf("left connection read failed before collection deadline: %v", err)
			}
		case err := <-rightErrs:
			if ctx.Err() == nil {
				t.Fatalf("right connection read failed before collection deadline: %v", err)
			}
		case <-ctx.Done():
			goto done
		}
	}
done:
	cancel()
	if len(leftBatches) == 0 {
		t.Fatalf("left connection received no candle batches for requestId %d in %s", requestID, within)
	}
	if len(rightBatches) == 0 {
		t.Fatalf("right connection received no candle batches for requestId %d in %s", requestID, within)
	}
	return leftBatches, rightBatches
}

func startMessagePump(ctx context.Context, conn *websocket.Conn) (<-chan map[string]any, <-chan error) {
	messages := make(chan map[string]any, 64)
	errs := make(chan error, 1)
	go func() {
		defer close(messages)
		for {
			typ, payload, err := conn.Read(ctx)
			if err != nil {
				if ctx.Err() == nil {
					errs <- err
				}
				return
			}
			if typ != websocket.MessageText {
				errs <- fmt.Errorf("message type = %v, want text", typ)
				return
			}
			dec := json.NewDecoder(bytes.NewReader(payload))
			dec.UseNumber()
			var body map[string]any
			if err := dec.Decode(&body); err != nil {
				errs <- fmt.Errorf("decode JSON %s: %w", payload, err)
				return
			}
			var extra any
			if err := dec.Decode(&extra); err != io.EOF {
				errs <- fmt.Errorf("extra JSON content in %s", payload)
				return
			}
			select {
			case messages <- body:
			case <-ctx.Done():
				return
			}
		}
	}()
	return messages, errs
}

func appendCandleBatch(t *testing.T, batches [][]map[string]any, msg map[string]any, requestID int64) [][]map[string]any {
	t.Helper()
	candles, ok := msg["candles"].(map[string]any)
	if !ok || int64At(t, candles, "requestId") != requestID {
		return batches
	}
	assertString(t, candles, "interval", "1s")
	rawItems := arrayAt(t, candles, "items")
	items := make([]map[string]any, 0, len(rawItems))
	for _, raw := range rawItems {
		items = append(items, asObject(t, raw))
	}
	return append(batches, items)
}

func flattenClosedCandles(t *testing.T, batches [][]map[string]any) []map[string]any {
	t.Helper()
	var closed []map[string]any
	for _, batch := range batches {
		for _, candle := range batch {
			if value, ok := candle["closed"].(bool); ok && value {
				closed = append(closed, candle)
			}
		}
	}
	if len(closed) == 0 {
		t.Fatal("received no closed candles")
	}
	return closed
}

func assertClosedCandleContinuity(t *testing.T, candles []map[string]any, interval string) {
	t.Helper()
	step := map[string]int64{"1s": 1000, "1m": 60000, "5m": 300000}[interval]
	latestByTime := map[int64]map[string]any{}
	var times []int64
	for _, candle := range candles {
		ts := int64At(t, candle, "t")
		if _, ok := latestByTime[ts]; !ok {
			times = append(times, ts)
		}
		latestByTime[ts] = candle
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	for i := 1; i < len(times); i++ {
		if got := times[i] - times[i-1]; got != step {
			t.Fatalf("closed candle gap = %dms between %d and %d, want %dms", got, times[i-1], times[i], step)
		}
	}
}

func assertOverlappedClosedCandlesMatch(t *testing.T, full, slow []map[string]any) {
	t.Helper()
	fullByTime := map[int64]map[string]any{}
	for _, candle := range full {
		fullByTime[int64At(t, candle, "t")] = candle
	}
	overlap := 0
	for _, candle := range slow {
		ts := int64At(t, candle, "t")
		fullCandle, ok := fullByTime[ts]
		if !ok {
			continue
		}
		overlap++
		assertCandleValueEquals(t, fullCandle, candle)
	}
	if overlap == 0 {
		t.Fatal("full and minimal clients had no overlapping closed candles")
	}
}

func assertCandleValueEquals(t *testing.T, left, right map[string]any) {
	t.Helper()
	for _, key := range []string{"t", "o", "h", "l", "c", "v", "rev", "closed"} {
		if left[key] != right[key] {
			t.Fatalf("candle field %s mismatch: full=%#v minimal=%#v", key, left, right)
		}
	}
}

func hasBookRange(msg map[string]any) bool {
	_, ok := msg["book"].(map[string]any)
	return ok
}

func assertNoTierBeforePong(t *testing.T, conn *websocket.Conn, forbiddenForced string) {
	t.Helper()
	deadline := time.Now().Add(750 * time.Millisecond)
	for time.Now().Before(deadline) {
		msg, ok := readOptional(t, conn, time.Until(deadline))
		if !ok {
			return
		}
		if msg["type"] == "tier" && msg["forced"] == forbiddenForced {
			t.Fatalf("other connection received forced tier update: %#v", msg)
		}
	}
}

func assertSessionSymbol(t *testing.T, body map[string]any) {
	t.Helper()
	assertString(t, body, "session", "")
	assertString(t, body, "symbol", "BTC-USD")
}

func assertErrorCode(t *testing.T, body map[string]any, want string) {
	t.Helper()
	errObj := objectAt(t, body, "error")
	assertString(t, errObj, "code", want)
	assertString(t, errObj, "message", "")
}

func assertLevels(t *testing.T, raw any, bids bool) {
	t.Helper()
	levels, ok := raw.([]any)
	if !ok {
		t.Fatalf("levels = %T, want array", raw)
	}
	if len(levels) < 10 || len(levels) > 50 {
		t.Fatalf("level count = %d, want 10..50", len(levels))
	}
	var previous int64
	for i, rawLevel := range levels {
		level, ok := rawLevel.([]any)
		if !ok || len(level) != 2 {
			t.Fatalf("level %d = %#v, want [price, quantity]", i, rawLevel)
		}
		price := assertDecimal(t, level[0], 2, false)
		qty := assertDecimal(t, level[1], 4, true)
		if qty <= 0 {
			t.Fatalf("snapshot level %d quantity = %d, want positive", i, qty)
		}
		if i > 0 {
			if bids && price >= previous {
				t.Fatalf("bid %d price = %d after %d, want descending", i, price, previous)
			}
			if !bids && price <= previous {
				t.Fatalf("ask %d price = %d after %d, want ascending", i, price, previous)
			}
		}
		previous = price
	}
}

func assertCandlesAscending(t *testing.T, candles []any, interval string) {
	t.Helper()
	step := map[string]int64{"1s": 1000, "1m": 60000, "5m": 300000}[interval]
	var previous int64 = -1
	for i, raw := range candles {
		candle := asObject(t, raw)
		ts := int64At(t, candle, "t")
		if ts%step != 0 {
			t.Fatalf("candle %d t = %d, want aligned to %s", i, ts, interval)
		}
		if ts <= previous {
			t.Fatalf("candle %d t = %d after %d, want ascending unique times", i, ts, previous)
		}
		previous = ts
		open := assertDecimal(t, candle["o"], 2, false)
		high := assertDecimal(t, candle["h"], 2, false)
		low := assertDecimal(t, candle["l"], 2, false)
		closePrice := assertDecimal(t, candle["c"], 2, false)
		_ = assertDecimal(t, candle["v"], 4, true)
		assertSafeUint(t, candle, "rev")
		if _, ok := candle["closed"].(bool); !ok {
			t.Fatalf("candle %d closed = %T, want bool", i, candle["closed"])
		}
		if low > open || low > closePrice || high < open || high < closePrice {
			t.Fatalf("candle %d OHLC out of order: %#v", i, candle)
		}
	}
}

func assertTrade(t *testing.T, trade map[string]any) {
	t.Helper()
	assertSafeUint(t, trade, "id")
	assertSafeUint(t, trade, "t")
	assertDecimal(t, trade["p"], 2, false)
	qty := assertDecimal(t, trade["q"], 4, true)
	if qty <= 0 {
		t.Fatalf("trade quantity = %d, want positive", qty)
	}
	side, ok := trade["side"].(string)
	if !ok || (side != "buy" && side != "sell") {
		t.Fatalf("trade side = %#v, want buy or sell", trade["side"])
	}
}

func assertDecimal(t *testing.T, raw any, scale int, allowZero bool) int64 {
	t.Helper()
	text, ok := raw.(string)
	if !ok {
		t.Fatalf("decimal = %T, want string", raw)
	}
	if text == "" || strings.ContainsAny(text, " +-eE\t\n\r") {
		t.Fatalf("decimal %q violates grammar", text)
	}
	parts := strings.Split(text, ".")
	if len(parts) > 2 || parts[0] == "" {
		t.Fatalf("decimal %q violates grammar", text)
	}
	whole, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		t.Fatalf("decimal %q whole parse: %v", text, err)
	}
	fracText := ""
	if len(parts) == 2 {
		fracText = parts[1]
		if fracText == "" || len(fracText) > scale {
			t.Fatalf("decimal %q has invalid precision", text)
		}
	}
	for len(fracText) < scale {
		fracText += "0"
	}
	frac := int64(0)
	if fracText != "" {
		parsed, err := strconv.ParseInt(fracText, 10, 64)
		if err != nil {
			t.Fatalf("decimal %q fraction parse: %v", text, err)
		}
		frac = parsed
	}
	mult := int64(1)
	for i := 0; i < scale; i++ {
		mult *= 10
	}
	value := whole*mult + frac
	if !allowZero && value <= 0 {
		t.Fatalf("decimal %q = %d, want positive", text, value)
	}
	return value
}

func assertSafeUint(t *testing.T, body map[string]any, key string) {
	t.Helper()
	got := int64At(t, body, key)
	if got < 0 || got > 9007199254740991 {
		t.Fatalf("%s = %d, want safe uint", key, got)
	}
}

func assertString(t *testing.T, body map[string]any, key, want string) {
	t.Helper()
	got, ok := body[key].(string)
	if !ok {
		t.Fatalf("%s = %T, want string", key, body[key])
	}
	if want != "" && got != want {
		t.Fatalf("%s = %q, want %q", key, got, want)
	}
	if got == "" {
		t.Fatalf("%s is empty", key)
	}
}

func assertBool(t *testing.T, body map[string]any, key string, want bool) {
	t.Helper()
	got, ok := body[key].(bool)
	if !ok {
		t.Fatalf("%s = %T, want bool", key, body[key])
	}
	if got != want {
		t.Fatalf("%s = %t, want %t", key, got, want)
	}
}

func assertNumberEquals(t *testing.T, body map[string]any, key string, want int64) {
	t.Helper()
	if got := int64At(t, body, key); got != want {
		t.Fatalf("%s = %d, want %d", key, got, want)
	}
}

func assertStringSlice(t *testing.T, body map[string]any, key string, want []string) {
	t.Helper()
	values := arrayAt(t, body, key)
	got := make([]string, len(values))
	for i, value := range values {
		text, ok := value.(string)
		if !ok {
			t.Fatalf("%s[%d] = %T, want string", key, i, value)
		}
		got[i] = text
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("%s = %v, want %v", key, got, want)
	}
}

func assertObjectKeys(t *testing.T, body map[string]any, want ...string) {
	t.Helper()
	got := make([]string, 0, len(body))
	for key := range body {
		got = append(got, key)
	}
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("keys = %v, want %v", got, want)
	}
}

func assertNoStore(t *testing.T, header http.Header) {
	t.Helper()
	if got := header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func assertVaryIncludes(t *testing.T, header http.Header, want string) {
	t.Helper()
	for _, value := range header.Values("Vary") {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), want) {
				return
			}
		}
	}
	t.Fatalf("Vary = %q, want to include %q", header.Values("Vary"), want)
}

func objectAt(t *testing.T, body map[string]any, key string) map[string]any {
	t.Helper()
	return asObject(t, body[key])
}

func asObject(t *testing.T, raw any) map[string]any {
	t.Helper()
	obj, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("value = %T, want object", raw)
	}
	return obj
}

func arrayAt(t *testing.T, body map[string]any, key string) []any {
	t.Helper()
	values, ok := body[key].([]any)
	if !ok {
		t.Fatalf("%s = %T, want array", key, body[key])
	}
	return values
}

func int64At(t *testing.T, body map[string]any, key string) int64 {
	t.Helper()
	switch value := body[key].(type) {
	case json.Number:
		got, err := value.Int64()
		if err != nil {
			t.Fatalf("%s = %v, want integer: %v", key, value, err)
		}
		return got
	case float64:
		got := int64(value)
		if float64(got) != value {
			t.Fatalf("%s = %v, want integer", key, value)
		}
		return got
	default:
		t.Fatalf("%s = %T, want number", key, body[key])
		return 0
	}
}

func mustJSON(value any) string {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Sprintf("<json error: %v>", err)
	}
	return string(payload)
}

func statusOf(resp *http.Response) any {
	if resp == nil {
		return nil
	}
	return resp.StatusCode
}
