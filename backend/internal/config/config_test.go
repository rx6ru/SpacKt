package config

import (
	"reflect"
	"strings"
	"testing"
)

func TestLoadUsesDefaultsWhenEnvironmentIsMissing(t *testing.T) {
	settings, err := Load(emptyLookup)

	if err != nil {
		t.Fatalf("Load() error = %v, want nil", err)
	}
	want := Settings{
		Port:                   8080,
		Seed:                   7,
		EpochMS:                0,
		HistoryMinutes:         360,
		AllowedOrigins:         []string{"http://localhost:3000", "http://127.0.0.1:3000"},
		DebugControls:          true,
		MaxConnections:         100,
		MarketFrameBudgetBytes: 1048576,
		BookChanges:            4096,
	}
	if !reflect.DeepEqual(settings, want) {
		t.Fatalf("Load() = %#v, want %#v", settings, want)
	}
}

func TestLoadAppliesEachEnvironmentOverride(t *testing.T) {
	tests := []struct {
		name string
		key  string
		val  string
		want func(Settings) bool
	}{
		{name: "port", key: "PORT", val: "9090", want: func(s Settings) bool { return s.Port == 9090 }},
		{name: "zero seed", key: "SPACKT_SEED", val: "0", want: func(s Settings) bool { return s.Seed == 0 }},
		{name: "negative seed", key: "SPACKT_SEED", val: "-12", want: func(s Settings) bool { return s.Seed == -12 }},
		{name: "epoch", key: "SPACKT_EPOCH_MS", val: "1700000000000", want: func(s Settings) bool { return s.EpochMS == 1700000000000 }},
		{name: "history", key: "SPACKT_HISTORY_MINUTES", val: "1", want: func(s Settings) bool { return s.HistoryMinutes == 1 }},
		{name: "origins", key: "SPACKT_ALLOWED_ORIGINS", val: "https://spackt.example,http://localhost:3000", want: func(s Settings) bool {
			return reflect.DeepEqual(s.AllowedOrigins, []string{"https://spackt.example", "http://localhost:3000"})
		}},
		{name: "debug false", key: "SPACKT_DEBUG_CONTROLS", val: "false", want: func(s Settings) bool { return !s.DebugControls }},
		{name: "debug true", key: "SPACKT_DEBUG_CONTROLS", val: "true", want: func(s Settings) bool { return s.DebugControls }},
		{name: "max connections", key: "SPACKT_MAX_CONNECTIONS", val: "25", want: func(s Settings) bool { return s.MaxConnections == 25 }},
		{name: "market frame budget", key: "SPACKT_MARKET_FRAME_BUDGET_BYTES", val: "512", want: func(s Settings) bool { return s.MarketFrameBudgetBytes == 512 }},
		{name: "book changes", key: "SPACKT_BOOK_CHANGES", val: "64", want: func(s Settings) bool { return s.BookChanges == 64 }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			settings, err := Load(mapLookup(map[string]string{tt.key: tt.val}))
			if err != nil {
				t.Fatalf("Load() error = %v, want nil", err)
			}
			if !tt.want(settings) {
				t.Fatalf("Load() = %#v, want %s override %q", settings, tt.key, tt.val)
			}
		})
	}
}

func TestLoadRejectsPresentEmptyValues(t *testing.T) {
	for _, key := range configKeys() {
		t.Run(key, func(t *testing.T) {
			_, err := Load(mapLookup(map[string]string{key: ""}))

			requireInvalidKey(t, err, key)
		})
	}
}

func TestLoadRejectsInvalidDecimalIntegers(t *testing.T) {
	tests := []struct {
		key string
		val string
	}{
		{key: "PORT", val: "80.5"},
		{key: "PORT", val: " 80"},
		{key: "SPACKT_SEED", val: "+1"},
		{key: "SPACKT_SEED", val: "9223372036854775808"},
		{key: "SPACKT_EPOCH_MS", val: "1e3"},
		{key: "SPACKT_HISTORY_MINUTES", val: "ten"},
		{key: "SPACKT_MAX_CONNECTIONS", val: "1.0"},
		{key: "SPACKT_MARKET_FRAME_BUDGET_BYTES", val: "-1"},
		{key: "SPACKT_BOOK_CHANGES", val: "0x10"},
	}
	for _, tt := range tests {
		t.Run(tt.key+"="+tt.val, func(t *testing.T) {
			_, err := Load(mapLookup(map[string]string{tt.key: tt.val}))

			requireInvalidKey(t, err, tt.key)
		})
	}
}

func TestLoadRejectsInvalidBooleanValues(t *testing.T) {
	for _, val := range []string{"1", "TRUE", "yes"} {
		t.Run(val, func(t *testing.T) {
			_, err := Load(mapLookup(map[string]string{"SPACKT_DEBUG_CONTROLS": val}))

			requireInvalidKey(t, err, "SPACKT_DEBUG_CONTROLS")
		})
	}
}

func TestLoadRejectsOutOfRangeValues(t *testing.T) {
	tests := []struct {
		key string
		val string
	}{
		{key: "PORT", val: "0"},
		{key: "PORT", val: "65536"},
		{key: "SPACKT_EPOCH_MS", val: "-1"},
		{key: "SPACKT_HISTORY_MINUTES", val: "0"},
		{key: "SPACKT_HISTORY_MINUTES", val: "1441"},
		{key: "SPACKT_MAX_CONNECTIONS", val: "0"},
		{key: "SPACKT_MAX_CONNECTIONS", val: "101"},
		{key: "SPACKT_MARKET_FRAME_BUDGET_BYTES", val: "0"},
		{key: "SPACKT_MARKET_FRAME_BUDGET_BYTES", val: "1048577"},
		{key: "SPACKT_BOOK_CHANGES", val: "0"},
		{key: "SPACKT_BOOK_CHANGES", val: "4097"},
	}
	for _, tt := range tests {
		t.Run(tt.key+"="+tt.val, func(t *testing.T) {
			_, err := Load(mapLookup(map[string]string{tt.key: tt.val}))

			requireInvalidKey(t, err, tt.key)
		})
	}
}

func TestLoadRejectsHistoryWindowAboveSafeJavaScriptTime(t *testing.T) {
	_, err := Load(mapLookup(map[string]string{
		"SPACKT_EPOCH_MS":        "9007199254740990",
		"SPACKT_HISTORY_MINUTES": "1",
	}))

	requireInvalidKey(t, err, "SPACKT_EPOCH_MS")
	if !strings.Contains(err.Error(), "SPACKT_HISTORY_MINUTES") {
		t.Fatalf("error = %q, want it to name SPACKT_HISTORY_MINUTES too", err.Error())
	}
}

func TestLoadAcceptsLargestSafeHistoryWindow(t *testing.T) {
	settings, err := Load(mapLookup(map[string]string{
		"SPACKT_EPOCH_MS":        "9007199254680991",
		"SPACKT_HISTORY_MINUTES": "1",
	}))

	if err != nil {
		t.Fatalf("Load() error = %v, want nil", err)
	}
	if settings.EpochMS != 9007199254680991 || settings.HistoryMinutes != 1 {
		t.Fatalf("Load() = EpochMS %d HistoryMinutes %d, want safe boundary", settings.EpochMS, settings.HistoryMinutes)
	}
}

func TestLoadTrimsOriginSeparatorWhitespace(t *testing.T) {
	settings, err := Load(mapLookup(map[string]string{
		"SPACKT_ALLOWED_ORIGINS": "https://app.example, http://localhost:3000 ,http://127.0.0.1:3000",
	}))

	if err != nil {
		t.Fatalf("Load() error = %v, want nil", err)
	}
	want := []string{"https://app.example", "http://localhost:3000", "http://127.0.0.1:3000"}
	if !reflect.DeepEqual(settings.AllowedOrigins, want) {
		t.Fatalf("AllowedOrigins = %#v, want %#v", settings.AllowedOrigins, want)
	}
}

func TestLoadRejectsInvalidOrigins(t *testing.T) {
	tests := []string{
		"",
		"*",
		"https://user:pass@app.example",
		"https://app.example/path",
		"https://app.example?x=1",
		"https://app.example#fragment",
		"ftp://app.example",
		"https://app.example:bad",
		"http://app.example:0",
		"https://app.example:65536",
		"https://",
		"https://app.example,",
		"https://app.example,,http://localhost:3000",
	}
	for _, val := range tests {
		t.Run(val, func(t *testing.T) {
			_, err := Load(mapLookup(map[string]string{"SPACKT_ALLOWED_ORIGINS": val}))

			requireInvalidKey(t, err, "SPACKT_ALLOWED_ORIGINS")
		})
	}
}

func TestLoadDoesNotEchoInvalidEnvironmentValues(t *testing.T) {
	secretValue := "super-secret-invalid-value"

	_, err := Load(mapLookup(map[string]string{"PORT": secretValue}))

	requireInvalidKey(t, err, "PORT")
	if strings.Contains(err.Error(), secretValue) {
		t.Fatalf("error = %q, want it to omit the invalid value", err.Error())
	}
}

func TestLoadReturnsIndependentOriginSlices(t *testing.T) {
	first, err := Load(emptyLookup)
	if err != nil {
		t.Fatalf("first Load() error = %v", err)
	}
	second, err := Load(emptyLookup)
	if err != nil {
		t.Fatalf("second Load() error = %v", err)
	}

	first.AllowedOrigins[0] = "https://mutated.example"

	if got := second.AllowedOrigins[0]; got != "http://localhost:3000" {
		t.Fatalf("second AllowedOrigins[0] = %q, want independent default slice", got)
	}
}

func TestLoadReadsOnlyDocumentedKeys(t *testing.T) {
	var read []string
	_, _ = Load(func(key string) (string, bool) {
		read = append(read, key)
		return "", false
	})

	want := configKeys()
	if !sameStringSet(read, want) {
		t.Fatalf("lookup keys = %#v, want %#v", read, want)
	}
}

func emptyLookup(string) (string, bool) {
	return "", false
}

func mapLookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func configKeys() []string {
	return []string{
		"PORT",
		"SPACKT_SEED",
		"SPACKT_EPOCH_MS",
		"SPACKT_HISTORY_MINUTES",
		"SPACKT_ALLOWED_ORIGINS",
		"SPACKT_DEBUG_CONTROLS",
		"SPACKT_MAX_CONNECTIONS",
		"SPACKT_MARKET_FRAME_BUDGET_BYTES",
		"SPACKT_BOOK_CHANGES",
	}
}

func requireInvalidKey(t *testing.T, err error, key string) {
	t.Helper()
	if err == nil {
		t.Fatalf("Load() error = nil, want error naming %s", key)
	}
	if !strings.Contains(err.Error(), key) {
		t.Fatalf("error = %q, want it to name %s", err.Error(), key)
	}
}

func sameStringSet(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	seen := make(map[string]bool, len(got))
	for _, value := range got {
		seen[value] = true
	}
	for _, value := range want {
		if !seen[value] {
			return false
		}
	}
	return true
}
