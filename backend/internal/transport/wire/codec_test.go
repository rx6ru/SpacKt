package wire

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type fixtureCase struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Valid bool   `json:"valid"`
	File  string `json:"file"`
}

func readFixtureCases(t *testing.T) []fixtureCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "fixtures", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []fixtureCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestDecodeAcceptsAndRejectsSharedProtocolFixtures(t *testing.T) {
	for _, tc := range readFixtureCases(t) {
		t.Run(tc.Name, func(t *testing.T) {
			decoded, err := Decode(tc.Kind, readFixture(t, tc.File))
			if tc.Valid && err != nil {
				t.Fatalf("Decode(%q, %s) returned error for valid fixture: %v", tc.Kind, tc.File, err)
			}
			if !tc.Valid {
				if err == nil {
					t.Fatalf("Decode(%q, %s) accepted invalid fixture: %#v", tc.Kind, tc.File, decoded)
				}
				return
			}
			encoded, err := Encode(tc.Kind, decoded)
			if err != nil {
				t.Fatalf("Encode(%q, %s) returned error after valid decode: %v", tc.Kind, tc.File, err)
			}
			roundTripped, err := Decode(tc.Kind, encoded)
			if err != nil {
				t.Fatalf("Decode(%q, encoded %s) returned error: %v", tc.Kind, tc.File, err)
			}
			if !reflect.DeepEqual(roundTripped, decoded) {
				t.Fatalf("round trip changed decoded value for %s:\noriginal: %#v\nencoded: %s\nround trip: %#v", tc.File, decoded, encoded, roundTripped)
			}
		})
	}
}

func TestEncodeRejectsInvalidValues(t *testing.T) {
	if encoded, err := Encode("client", map[string]any{
		"type":    "ping",
		"session": "s1",
		"id":      float64(1),
		"extra":   true,
	}); err == nil {
		t.Fatalf("Encode accepted value with unknown field: %s", encoded)
	}
}

func TestDecodeUsesLastCompleteDuplicateObjectBeforeStrictValidation(t *testing.T) {
	decoded, err := Decode("meta", readFixture(t, "valid-meta-duplicate-flush.json"))
	if err != nil {
		t.Fatalf("duplicate nested object fixture should be valid: %v", err)
	}
	policy, ok := decoded["tierPolicy"].(map[string]any)
	if !ok {
		t.Fatalf("tierPolicy has unexpected shape: %#v", decoded["tierPolicy"])
	}
	flush, ok := policy["flushMs"].(map[string]any)
	if !ok {
		t.Fatalf("flushMs has unexpected shape: %#v", policy["flushMs"])
	}
	if _, exists := flush["debug"]; exists {
		t.Fatalf("duplicate object was merged instead of replaced: %#v", flush)
	}
	if flush["full"] != float64(100) || flush["degraded"] != float64(500) || flush["minimal"] != float64(2000) {
		t.Fatalf("last complete flushMs object was not preserved: %#v", flush)
	}
}

func TestToTradeMapsWireTradeWithoutFloatDrift(t *testing.T) {
	decoded, err := Decode("trades", readFixture(t, "valid-trades-max-safe.json"))
	if err != nil {
		t.Fatalf("Decode returned error for max safe trade fixture: %v", err)
	}
	trades, ok := decoded["trades"].([]any)
	if !ok || len(trades) != 1 {
		t.Fatalf("decoded trades have unexpected shape: %#v", decoded["trades"])
	}
	rawTrade, ok := trades[0].(map[string]any)
	if !ok {
		t.Fatalf("decoded trade has unexpected shape: %#v", trades[0])
	}

	trade, err := ToTrade(rawTrade)
	if err != nil {
		t.Fatalf("ToTrade returned error: %v", err)
	}
	if trade.ID != 9007199254740991 || trade.TimeMS != 1700000000800 || trade.PriceTicks != 6423050 || trade.QuantityLots != 12300 || trade.Side != "buy" {
		t.Fatalf("wire trade mapped incorrectly: %#v", trade)
	}
}

func TestDecodeRejectsUnsafeIDsInvalidEnumsAndInvalidPrecision(t *testing.T) {
	tests := []struct {
		name string
		kind string
		raw  string
	}{
		{
			name: "unsafe trade id",
			kind: "trades",
			raw:  `{"session":"s1","symbol":"BTC-USD","trades":[{"id":9007199254740992,"t":1700000000800,"p":"64230.50","q":"1.2300","side":"sell"}]}`,
		},
		{
			name: "invalid side alphabet",
			kind: "trades",
			raw:  `{"session":"s1","symbol":"BTC-USD","trades":[{"id":8,"t":1700000000800,"p":"64230.50","q":"1.2300","side":"BUY"}]}`,
		},
		{
			name: "invalid interval alphabet",
			kind: "client",
			raw:  `{"type":"subscribe","session":"s1","interval":"01s","requestId":1}`,
		},
		{
			name: "invalid tier alphabet",
			kind: "client",
			raw:  `{"type":"debug","session":"s1","action":"forceTier","value":"Full"}`,
		},
		{
			name: "exponent price",
			kind: "trades",
			raw:  `{"session":"s1","symbol":"BTC-USD","trades":[{"id":8,"t":1700000000800,"p":"1e2","q":"1.2300","side":"sell"}]}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if decoded, err := Decode(tt.kind, []byte(tt.raw)); err == nil {
				t.Fatalf("Decode accepted invalid input: %#v", decoded)
			}
		})
	}
}

func TestDecodeCountsDisplayTextByUnicodeCharactersAndUTF8Bytes(t *testing.T) {
	validMessage := strings.Repeat("😀", 160)
	validRaw, err := json.Marshal(map[string]any{
		"error": map[string]any{"code": "bad_request", "message": validMessage},
	})
	if err != nil {
		t.Fatal(err)
	}
	if decoded, err := Decode("httpError", validRaw); err != nil {
		t.Fatalf("Decode rejected 160 Unicode characters at 640 UTF-8 bytes: %v\nvalue: %#v", err, decoded)
	}

	invalidMessage := strings.Repeat("😀", 161)
	invalidRaw, err := json.Marshal(map[string]any{
		"error": map[string]any{"code": "bad_request", "message": invalidMessage},
	})
	if err != nil {
		t.Fatal(err)
	}
	if decoded, err := Decode("httpError", invalidRaw); err == nil {
		t.Fatalf("Decode accepted 161 Unicode characters over 640 UTF-8 bytes: %#v", decoded)
	}
}

func TestDecodeRejectsWireByteAndNestingBounds(t *testing.T) {
	validPing := `{"type":"ping","session":"s1","id":1}`
	oversized := []byte(validPing + strings.Repeat(" ", 4097-len(validPing)))
	if decoded, err := Decode("client", oversized); err == nil {
		t.Fatalf("Decode accepted client WebSocket frame over 4096 bytes: %#v", decoded)
	}

	deep := []byte(`{"type":"ping","session":"s1","id":1,"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":{"j":{"k":{"l":{"m":1}}}}}}}}}}}}}`)
	if decoded, err := Decode("client", deep); err == nil {
		t.Fatalf("Decode accepted JSON deeper than 12 levels: %#v", decoded)
	} else if !strings.Contains(strings.ToLower(err.Error()), "depth") {
		t.Fatalf("Decode rejected depth-13 JSON for the wrong public reason: %v", err)
	}
}

func TestDecodeRejectsDocumentedSchemaMutations(t *testing.T) {
	tests := []struct {
		name   string
		kind   string
		file   string
		mutate func(map[string]any)
	}{
		{name: "meta rejects non increasing flush rates", kind: "meta", file: "valid-meta.json", mutate: func(v map[string]any) {
			objectAt(v, "tierPolicy", "flushMs")["full"] = float64(500)
		}},
		{name: "meta rejects recovery threshold at entry boundary", kind: "meta", file: "valid-meta.json", mutate: func(v map[string]any) {
			objectAt(v, "tierPolicy", "recoverFull")["latencyBelowMs"] = float64(400)
		}},
		{name: "meta rejects zero duration", kind: "meta", file: "valid-meta.json", mutate: func(v map[string]any) {
			objectAt(v, "tierPolicy")["pingEveryMs"] = float64(0)
		}},
		{name: "meta rejects duration above maximum", kind: "meta", file: "valid-meta.json", mutate: func(v map[string]any) {
			objectAt(v, "tierPolicy")["hiddenCloseMs"] = float64(3600001)
		}},
		{name: "meta rejects minimum samples below lower bound", kind: "meta", file: "valid-meta.json", mutate: func(v map[string]any) {
			objectAt(v, "tierPolicy")["minimumReportSamples"] = float64(1)
		}},
		{name: "meta rejects rtt sample window above maximum", kind: "meta", file: "valid-meta.json", mutate: func(v map[string]any) {
			objectAt(v, "tierPolicy")["rttWindowSamples"] = float64(11)
		}},
		{name: "meta rejects invalid session charset", kind: "meta", file: "valid-meta.json", mutate: func(v map[string]any) {
			v["session"] = "bad session"
		}},
		{name: "meta rejects session length above maximum", kind: "meta", file: "valid-meta.json", mutate: func(v map[string]any) {
			v["session"] = strings.Repeat("a", 65)
		}},
		{name: "meta rejects wrong intervals type", kind: "meta", file: "valid-meta.json", mutate: func(v map[string]any) {
			v["intervals"] = "1s"
		}},
		{name: "health rejects missing status", kind: "health", file: "valid-health.json", mutate: func(v map[string]any) {
			delete(v, "status")
		}},
		{name: "readiness rejects unknown status", kind: "readiness", file: "valid-readiness.json", mutate: func(v map[string]any) {
			v["status"] = "warming"
		}},
		{name: "http error rejects control characters in message", kind: "httpError", file: "valid-http-error.json", mutate: func(v map[string]any) {
			objectAt(v, "error")["message"] = "bad\nrequest"
		}},
		{name: "book rejects duplicate bid prices", kind: "book", file: "valid-book.json", mutate: func(v map[string]any) {
			bids := arrayAt(v, "bids")
			bids[1].([]any)[0] = bids[0].([]any)[0]
		}},
		{name: "book rejects unsorted bids", kind: "book", file: "valid-book.json", mutate: func(v map[string]any) {
			arrayAt(v, "bids")[1].([]any)[0] = "100.00"
		}},
		{name: "book rejects crossed best levels", kind: "book", file: "valid-book.json", mutate: func(v map[string]any) {
			arrayAt(v, "asks")[0].([]any)[0] = "98.00"
		}},
		{name: "book rejects zero quantity snapshot level", kind: "book", file: "valid-book.json", mutate: func(v map[string]any) {
			arrayAt(v, "bids")[0].([]any)[1] = "0"
		}},
		{name: "history rejects candle low above open", kind: "history", file: "valid-history.json", mutate: func(v map[string]any) {
			firstCandle(v)["l"] = "101.00"
		}},
		{name: "history rejects zero volume with unequal OHLC", kind: "history", file: "valid-history.json", mutate: func(v map[string]any) {
			c := firstCandle(v)
			c["v"] = "0"
			c["c"] = "101.00"
		}},
		{name: "history rejects unaligned candle time", kind: "history", file: "valid-history.json", mutate: func(v map[string]any) {
			firstCandle(v)["t"] = float64(1700000000001)
		}},
		{name: "recent trades reject ascending order", kind: "trades", file: "valid-trades.json", mutate: func(v map[string]any) {
			v["trades"] = []any{
				map[string]any{"id": float64(8), "t": float64(1700000000800), "p": "99.00", "q": "1.0000", "side": "buy"},
				map[string]any{"id": float64(9), "t": float64(1700000000900), "p": "100.00", "q": "1.0000", "side": "sell"},
			}
		}},
		{name: "recent trades reject duplicate IDs", kind: "trades", file: "valid-trades.json", mutate: func(v map[string]any) {
			v["trades"] = []any{
				map[string]any{"id": float64(8), "t": float64(1700000000800), "p": "99.00", "q": "1.0000", "side": "buy"},
				map[string]any{"id": float64(8), "t": float64(1700000000700), "p": "98.00", "q": "1.0000", "side": "sell"},
			}
		}},
		{name: "server update rejects candle rev above market rev", kind: "server", file: "valid-server-update.json", mutate: func(v map[string]any) {
			firstUpdateCandle(v)["rev"] = float64(85)
		}},
		{name: "server update rejects empty payload", kind: "server", file: "valid-server-update.json", mutate: func(v map[string]any) {
			delete(v, "book")
			delete(v, "candles")
			delete(v, "trades")
			delete(v, "skipped")
		}},
		{name: "server update rejects skipped without trades", kind: "server", file: "valid-server-update.json", mutate: func(v map[string]any) {
			delete(v, "trades")
		}},
		{name: "server update rejects explicit null book with valid candles", kind: "server", file: "valid-server-update.json", mutate: func(v map[string]any) {
			v["book"] = nil
			delete(v, "trades")
			delete(v, "skipped")
		}},
		{name: "server update rejects explicit null candles with valid book", kind: "server", file: "valid-server-update.json", mutate: func(v map[string]any) {
			v["candles"] = nil
			delete(v, "trades")
			delete(v, "skipped")
		}},
		{name: "server update rejects explicit null trades with valid candles", kind: "server", file: "valid-server-update.json", mutate: func(v map[string]any) {
			v["trades"] = nil
			delete(v, "book")
			delete(v, "skipped")
		}},
		{name: "server update rejects explicit null skipped with valid book", kind: "server", file: "valid-server-update.json", mutate: func(v map[string]any) {
			v["skipped"] = nil
			delete(v, "candles")
			delete(v, "trades")
		}},
		{name: "server update rejects duplicate trade IDs", kind: "server", file: "valid-server-update.json", mutate: func(v map[string]any) {
			v["trades"] = []any{
				map[string]any{"id": float64(8), "t": float64(1700000000800), "p": "99.00", "q": "1.0000", "side": "buy"},
				map[string]any{"id": float64(8), "t": float64(1700000000900), "p": "100.00", "q": "1.0000", "side": "sell"},
			}
		}},
		{name: "client ping rejects null id", kind: "client", file: "valid-client-ping.json", mutate: func(v map[string]any) {
			v["id"] = nil
		}},
		{name: "client report rejects samples below lower bound", kind: "client", file: "valid-client-report.json", mutate: func(v map[string]any) {
			v["samples"] = float64(1)
		}},
		{name: "client report rejects samples above upper bound", kind: "client", file: "valid-client-report.json", mutate: func(v map[string]any) {
			v["samples"] = float64(11)
		}},
		{name: "server hello rejects missing version", kind: "server", file: "valid-server-hello.json", mutate: func(v map[string]any) {
			delete(v, "v")
		}},
		{name: "server hello rejects wrong hidden type", kind: "server", file: "valid-server-hello.json", mutate: func(v map[string]any) {
			v["hidden"] = "false"
		}},
		{name: "server error rejects invalid error code", kind: "server", file: "valid-server-error.json", mutate: func(v map[string]any) {
			v["code"] = "not_a_code"
		}},
		{name: "server hello rejects overlong connection id", kind: "server", file: "valid-server-hello.json", mutate: func(v map[string]any) {
			v["connId"] = strings.Repeat("c", 65)
		}},
		{name: "server tier rejects overlong reason", kind: "server", file: "valid-server-tier.json", mutate: func(v map[string]any) {
			v["reason"] = strings.Repeat("r", 161)
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := mutatedFixture(t, tt.file, tt.mutate)
			if decoded, err := Decode(tt.kind, raw); err == nil {
				t.Fatalf("Decode accepted invalid mutation: %#v\nraw: %s", decoded, raw)
			}
		})
	}
}

func TestDecodeRejectsAllRequiredMetaFieldDeletions(t *testing.T) {
	requiredPaths := [][]string{
		{"session"}, {"symbol"}, {"tickSize"}, {"lotSize"}, {"intervals"}, {"referencePrice"}, {"tierPolicy"}, {"retention"},
		{"tierPolicy", "initialTier"}, {"tierPolicy", "flushMs"}, {"tierPolicy", "enterDegraded"}, {"tierPolicy", "enterMinimal"},
		{"tierPolicy", "recoverFull"}, {"tierPolicy", "recoverDegraded"}, {"tierPolicy", "downgradeDwellMs"}, {"tierPolicy", "upgradeDwellMs"},
		{"tierPolicy", "missingReportStepMs"}, {"tierPolicy", "missingReportMinimalMs"}, {"tierPolicy", "pingEveryMs"},
		{"tierPolicy", "pongTimeoutMs"}, {"tierPolicy", "reportEveryMs"}, {"tierPolicy", "rttWindowSamples"},
		{"tierPolicy", "minimumReportSamples"}, {"tierPolicy", "hiddenCloseMs"}, {"tierPolicy", "flushMs", "full"},
		{"tierPolicy", "flushMs", "degraded"}, {"tierPolicy", "flushMs", "minimal"}, {"retention", "historyCandles"},
		{"retention", "deliveryClosedCandles"}, {"retention", "recentTrades"}, {"retention", "bookChanges"},
		{"retention", "maximumBookLevelsPerSide"}, {"retention", "historyCandles", "1s"}, {"retention", "historyCandles", "1m"},
		{"retention", "historyCandles", "5m"},
	}

	for _, path := range requiredPaths {
		t.Run(strings.Join(path, "."), func(t *testing.T) {
			raw := mutatedFixture(t, "valid-meta.json", func(v map[string]any) { deletePath(v, path...) })
			if decoded, err := Decode("meta", raw); err == nil {
				t.Fatalf("Decode accepted meta with missing %s: %#v", strings.Join(path, "."), decoded)
			}
		})
	}
}

func TestDecodeRejectsUnsupportedKindInvalidJSONAndTrailingDocument(t *testing.T) {
	if decoded, err := Decode("unknown", readFixture(t, "valid-health.json")); err == nil {
		t.Fatalf("Decode accepted unsupported kind: %#v", decoded)
	}
	if decoded, err := Decode("health", []byte(`{"status":"ok"`)); err == nil {
		t.Fatalf("Decode accepted invalid JSON: %#v", decoded)
	}
	if decoded, err := Decode("health", []byte(`{"status":"ok"}{"status":"ok"}`)); err == nil {
		t.Fatalf("Decode accepted trailing JSON document: %#v", decoded)
	}
}

func TestDecodeAcceptsSupportedHistoryIntervalsWithAlignedCandleTimes(t *testing.T) {
	tests := []struct {
		name     string
		interval string
		timeMS   float64
	}{
		{name: "one second", interval: "1s", timeMS: 1700000000000},
		{name: "one minute", interval: "1m", timeMS: 1700000040000},
		{name: "five minutes", interval: "5m", timeMS: 1700000100000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := mutatedFixture(t, "valid-history.json", func(v map[string]any) {
				v["interval"] = tt.interval
				firstCandle(v)["t"] = tt.timeMS
			})
			if decoded, err := Decode("history", raw); err != nil {
				t.Fatalf("Decode rejected valid %s history candle: %v\nvalue: %#v", tt.interval, err, decoded)
			}
		})
	}
}

func TestDecodeAcceptsSupportedUpdateCandleIntervalsWithAlignedTimes(t *testing.T) {
	tests := []struct {
		name     string
		interval string
		timeMS   float64
	}{
		{name: "one second", interval: "1s", timeMS: 1700000000000},
		{name: "one minute", interval: "1m", timeMS: 1700000040000},
		{name: "five minutes", interval: "5m", timeMS: 1700000100000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := mutatedFixture(t, "valid-server-update.json", func(v map[string]any) {
				candles := objectAt(v, "candles")
				candles["interval"] = tt.interval
				firstUpdateCandle(v)["t"] = tt.timeMS
			})
			if decoded, err := Decode("server", raw); err != nil {
				t.Fatalf("Decode rejected valid %s update candle batch: %v\nvalue: %#v", tt.interval, err, decoded)
			}
		})
	}
}

func TestDecodeValidatesHeartbeatNullableCandleHeads(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
		valid  bool
	}{
		{name: "zero candle request id rejects", valid: false, mutate: func(v map[string]any) {
			v["candleRequestId"] = float64(0)
			v["candleLatestRev"] = nil
		}},
		{name: "zero candle latest revision rejects", valid: false, mutate: func(v map[string]any) {
			v["candleRequestId"] = float64(1)
			v["candleLatestRev"] = float64(0)
		}},
		{name: "positive request id with null latest revision accepts", valid: true, mutate: func(v map[string]any) {
			v["candleRequestId"] = float64(1)
			v["candleLatestRev"] = nil
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := mutatedFixture(t, "valid-server-heartbeat.json", tt.mutate)
			decoded, err := Decode("server", raw)
			if tt.valid && err != nil {
				t.Fatalf("Decode rejected valid heartbeat: %v\nvalue: %#v", err, decoded)
			}
			if !tt.valid && err == nil {
				t.Fatalf("Decode accepted invalid heartbeat: %#v", decoded)
			}
		})
	}
}

func TestDecodeValidatesDebugActionBounds(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
		valid  bool
	}{
		{name: "unknown debug action rejects", valid: false, mutate: func(v map[string]any) {
			v["action"] = "resetAll"
			delete(v, "value")
		}},
		{name: "pongDelay zero accepts", valid: true, mutate: func(v map[string]any) {
			v["value"] = float64(0)
		}},
		{name: "pongDelay four thousand accepts", valid: true, mutate: func(v map[string]any) {
			v["value"] = float64(4000)
		}},
		{name: "pongDelay four thousand one rejects", valid: false, mutate: func(v map[string]any) {
			v["value"] = float64(4001)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := mutatedFixture(t, "valid-client-debug-pong-delay.json", tt.mutate)
			decoded, err := Decode("client", raw)
			if tt.valid && err != nil {
				t.Fatalf("Decode rejected valid debug command: %v\nvalue: %#v", err, decoded)
			}
			if !tt.valid && err == nil {
				t.Fatalf("Decode accepted invalid debug command: %#v", decoded)
			}
		})
	}
}

func mutatedFixture(t *testing.T, file string, mutate func(map[string]any)) []byte {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(readFixture(t, file), &value); err != nil {
		t.Fatal(err)
	}
	mutate(value)
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func objectAt(value map[string]any, path ...string) map[string]any {
	current := value
	for _, key := range path {
		current = current[key].(map[string]any)
	}
	return current
}

func arrayAt(value map[string]any, key string) []any {
	return value[key].([]any)
}

func firstCandle(value map[string]any) map[string]any {
	return arrayAt(value, "candles")[0].(map[string]any)
}

func firstUpdateCandle(value map[string]any) map[string]any {
	return objectAt(value, "candles")["items"].([]any)[0].(map[string]any)
}

func deletePath(value map[string]any, path ...string) {
	current := value
	for _, key := range path[:len(path)-1] {
		current = current[key].(map[string]any)
	}
	delete(current, path[len(path)-1])
}
