package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

var ErrInvalidSetting = errors.New("invalid setting")

const maxSafeInteger = 9007199254740991

type Settings struct {
	Port                   int
	Seed                   int64
	EpochMS                int64
	HistoryMinutes         int
	AllowedOrigins         []string
	DebugControls          bool
	MaxConnections         int
	MarketFrameBudgetBytes int
	BookChanges            int
}

func Load(lookup func(string) (string, bool)) (Settings, error) {
	settings := Settings{
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

	var err error
	if settings.Port, err = intSetting(lookup, "PORT", settings.Port, 1, 65535); err != nil {
		return Settings{}, err
	}
	if settings.Seed, err = int64Setting(lookup, "SPACKT_SEED", settings.Seed, true, 0, 0); err != nil {
		return Settings{}, err
	}
	if settings.EpochMS, err = int64Setting(lookup, "SPACKT_EPOCH_MS", settings.EpochMS, false, 0, maxSafeInteger); err != nil {
		return Settings{}, err
	}
	if settings.HistoryMinutes, err = intSetting(lookup, "SPACKT_HISTORY_MINUTES", settings.HistoryMinutes, 1, 1440); err != nil {
		return Settings{}, err
	}
	if settings.AllowedOrigins, err = originsSetting(lookup, "SPACKT_ALLOWED_ORIGINS", settings.AllowedOrigins); err != nil {
		return Settings{}, err
	}
	if settings.DebugControls, err = boolSetting(lookup, "SPACKT_DEBUG_CONTROLS", settings.DebugControls); err != nil {
		return Settings{}, err
	}
	if settings.MaxConnections, err = intSetting(lookup, "SPACKT_MAX_CONNECTIONS", settings.MaxConnections, 1, 100); err != nil {
		return Settings{}, err
	}
	if settings.MarketFrameBudgetBytes, err = intSetting(lookup, "SPACKT_MARKET_FRAME_BUDGET_BYTES", settings.MarketFrameBudgetBytes, 1, 1048576); err != nil {
		return Settings{}, err
	}
	if settings.BookChanges, err = intSetting(lookup, "SPACKT_BOOK_CHANGES", settings.BookChanges, 1, 4096); err != nil {
		return Settings{}, err
	}

	historyMS := int64(settings.HistoryMinutes) * 60000
	if settings.EpochMS > maxSafeInteger-historyMS {
		return Settings{}, invalid("SPACKT_EPOCH_MS", "SPACKT_HISTORY_MINUTES")
	}
	settings.AllowedOrigins = append([]string(nil), settings.AllowedOrigins...)
	return settings, nil
}

func intSetting(lookup func(string) (string, bool), key string, fallback, min, max int) (int, error) {
	value, ok := lookup(key)
	if !ok {
		return fallback, nil
	}
	parsed, err := parseInt64(key, value, false)
	if err != nil {
		return 0, err
	}
	if parsed < int64(min) || parsed > int64(max) {
		return 0, invalid(key)
	}
	return int(parsed), nil
}

func int64Setting(lookup func(string) (string, bool), key string, fallback int64, allowNegative bool, min, max int64) (int64, error) {
	value, ok := lookup(key)
	if !ok {
		return fallback, nil
	}
	parsed, err := parseInt64(key, value, allowNegative)
	if err != nil {
		return 0, err
	}
	if !allowNegative && (parsed < min || parsed > max) {
		return 0, invalid(key)
	}
	return parsed, nil
}

func parseInt64(key, value string, allowNegative bool) (int64, error) {
	if value == "" {
		return 0, invalid(key)
	}
	if !decimalLiteral(value, allowNegative) {
		return 0, invalid(key)
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, invalid(key)
	}
	return parsed, nil
}

func decimalLiteral(value string, allowNegative bool) bool {
	if value == "" {
		return false
	}
	start := 0
	if value[0] == '-' {
		if !allowNegative || len(value) == 1 {
			return false
		}
		start = 1
	}
	for i := start; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

func boolSetting(lookup func(string) (string, bool), key string, fallback bool) (bool, error) {
	value, ok := lookup(key)
	if !ok {
		return fallback, nil
	}
	switch value {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, invalid(key)
	}
}

func originsSetting(lookup func(string) (string, bool), key string, fallback []string) ([]string, error) {
	value, ok := lookup(key)
	if !ok {
		return append([]string(nil), fallback...), nil
	}
	if value == "" {
		return nil, invalid(key)
	}
	parts := strings.Split(value, ",")
	origins := make([]string, 0, len(parts))
	for _, part := range parts {
		origin := strings.TrimSpace(part)
		if !validOrigin(origin) {
			return nil, invalid(key)
		}
		origins = append(origins, origin)
	}
	return origins, nil
}

func validOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if origin == "*" || parsed.Scheme != "http" && parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return false
	}
	if parsed.Path != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return false
	}
	if strings.ContainsAny(origin, "*[]\\ ") {
		return false
	}
	if parsed.Port() == "" && !strings.HasSuffix(parsed.Host, ":") {
		return true
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return host != "" && port >= 1 && port <= 65535 && net.JoinHostPort(host, strconv.Itoa(port)) == parsed.Host
}

func invalid(keys ...string) error {
	return fmt.Errorf("%w: %s", ErrInvalidSetting, strings.Join(keys, " and "))
}
