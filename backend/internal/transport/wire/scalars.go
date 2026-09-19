package wire

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var (
	sessionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	decimalPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)
)

func validateCandleBatch(batch map[string]any, maxRev uint64) error {
	if err := exactKeys(batch, "requestId", "interval", "items"); err != nil {
		return err
	}
	if err := all(validPositiveID(batch, "requestId"), validIntervalField(batch, "interval")); err != nil {
		return err
	}
	items, err := arrayField(batch, "items")
	if err != nil {
		return err
	}
	interval, _ := stringField(batch, "interval")
	return validateCandles(items, 1, 65, true, maxRev, intervalMillis(interval))
}

func validateCandles(items []any, min, max int, requireRevLimit bool, maxRev uint64, intervalMS uint64) error {
	if len(items) < min || len(items) > max {
		return errors.New("candles length out of bounds")
	}
	var prevT uint64
	seen := make(map[uint64]bool, len(items))
	for i, item := range items {
		candle, ok := item.(map[string]any)
		if !ok {
			return errors.New("candle must be an object")
		}
		if err := exactKeys(candle, "t", "o", "h", "l", "c", "v", "rev", "closed"); err != nil {
			return err
		}
		t, err := safeUint(candle["t"], "t", 0)
		if err != nil {
			return err
		}
		if intervalMS == 0 || t%intervalMS != 0 {
			return errors.New("candle time must align with interval")
		}
		if i > 0 && t <= prevT {
			return errors.New("candles must ascend by time")
		}
		if seen[t] {
			return errors.New("duplicate candle time")
		}
		seen[t] = true
		prevT = t
		o, err := decimalScaled(candle["o"], "o", 2, 16, true)
		if err != nil {
			return err
		}
		h, err := decimalScaled(candle["h"], "h", 2, 16, true)
		if err != nil {
			return err
		}
		l, err := decimalScaled(candle["l"], "l", 2, 16, true)
		if err != nil {
			return err
		}
		c, err := decimalScaled(candle["c"], "c", 2, 16, true)
		if err != nil {
			return err
		}
		if l > o || l > c || h < o || h < c {
			return errors.New("candle OHLC values are inconsistent")
		}
		volume, err := decimalScaled(candle["v"], "v", 4, 18, false)
		if err != nil {
			return err
		}
		if volume == 0 && !(o == h && h == l && l == c) {
			return errors.New("zero-volume candle must have equal OHLC values")
		}
		rev, err := safeUint(candle["rev"], "rev", 1)
		if err != nil {
			return err
		}
		if requireRevLimit && rev > maxRev {
			return errors.New("candle rev exceeds update marketRev")
		}
		if err := boolFieldOnly(candle, "closed"); err != nil {
			return err
		}
	}
	return nil
}

func intervalMillis(interval string) uint64 {
	switch interval {
	case "1s":
		return 1000
	case "1m":
		return 60000
	case "5m":
		return 300000
	default:
		return 0
	}
}

func validateTradeList(items []any, min, max int, descending bool) error {
	if len(items) < min || len(items) > max {
		return errors.New("trades length out of bounds")
	}
	seen := make(map[uint64]bool, len(items))
	var prev uint64
	for i, item := range items {
		trade, ok := item.(map[string]any)
		if !ok {
			return errors.New("trade must be an object")
		}
		if err := validateTrade(trade, true); err != nil {
			return err
		}
		id, _ := safeUint(trade["id"], "id", 1)
		if seen[id] {
			return errors.New("duplicate trade id")
		}
		seen[id] = true
		if i > 0 {
			if descending && id >= prev {
				return errors.New("trades must descend by id")
			}
			if !descending && id <= prev {
				return errors.New("trades must ascend by id")
			}
		}
		prev = id
	}
	return nil
}

func validateTrade(trade map[string]any, positiveQuantity bool) error {
	if err := exactKeys(trade, "id", "t", "p", "q", "side"); err != nil {
		return err
	}
	if err := all(validPositiveID(trade, "id"), validSafeUint(trade, "t"), decimalLiteral(trade, "p", 2, 16, true)); err != nil {
		return err
	}
	if _, err := decimalScaled(trade["q"], "q", 4, 18, positiveQuantity); err != nil {
		return err
	}
	side, err := stringField(trade, "side")
	if err != nil {
		return err
	}
	if side != "buy" && side != "sell" {
		return fmt.Errorf("invalid side %q", side)
	}
	return nil
}

func validateLevels(items []any, min, max int, requirePositive, enforceOrder, descending bool) error {
	if len(items) < min || len(items) > max {
		return errors.New("levels length out of bounds")
	}
	seen := make(map[int64]bool, len(items))
	var prev int64
	for i, item := range items {
		level, ok := item.([]any)
		if !ok || len(level) != 2 {
			return errors.New("level must be a two-item array")
		}
		price, err := decimalScaled(level[0], "price", 2, 16, true)
		if err != nil {
			return err
		}
		if seen[price] {
			return errors.New("duplicate level price")
		}
		seen[price] = true
		if _, err := decimalScaled(level[1], "quantity", 4, 18, requirePositive); err != nil {
			return err
		}
		if enforceOrder && i > 0 {
			if descending && price >= prev {
				return errors.New("bid prices must descend")
			}
			if !descending && price <= prev {
				return errors.New("ask prices must ascend")
			}
		}
		prev = price
	}
	return nil
}

func levelPrice(item any) (int64, error) {
	level, ok := item.([]any)
	if !ok || len(level) != 2 {
		return 0, errors.New("level must be a two-item array")
	}
	return decimalScaled(level[0], "price", 2, 16, true)
}

func commonTyped(root map[string]any) (string, error) {
	if err := sessionField(root); err != nil {
		return "", err
	}
	return stringField(root, "type")
}

func exactKeys(value map[string]any, keys ...string) error {
	if len(value) != len(keys) {
		return fmt.Errorf("expected fields %v", keys)
	}
	for _, key := range keys {
		if _, ok := value[key]; !ok {
			return fmt.Errorf("missing field %q", key)
		}
	}
	for key := range value {
		if !contains(keys, key) {
			return fmt.Errorf("unknown field %q", key)
		}
	}
	return nil
}

func optionalExactKeys(value map[string]any, required, optional []string) error {
	for _, key := range required {
		if _, ok := value[key]; !ok {
			return fmt.Errorf("missing field %q", key)
		}
	}
	for key := range value {
		if contains(required, key) || contains(optional, key) {
			continue
		}
		return fmt.Errorf("unknown field %q", key)
	}
	return nil
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func all(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func stringField(value map[string]any, key string) (string, error) {
	v, ok := value[key].(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return v, nil
}

func literalString(value map[string]any, key, want string) error {
	got, err := stringField(value, key)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("%s must be %q", key, want)
	}
	return nil
}

func mapField(value map[string]any, key string) (map[string]any, error) {
	v, ok := value[key].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an object", key)
	}
	return v, nil
}

func arrayField(value map[string]any, key string) ([]any, error) {
	v, ok := value[key].([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array", key)
	}
	return v, nil
}

func boolFieldOnly(value map[string]any, key string) error {
	if _, ok := value[key].(bool); !ok {
		return fmt.Errorf("%s must be a boolean", key)
	}
	return nil
}

func sessionField(value map[string]any) error {
	session, err := stringField(value, "session")
	if err != nil {
		return err
	}
	if !sessionPattern.MatchString(session) {
		return errors.New("invalid session")
	}
	return nil
}

func connectionField(value map[string]any, key string) error {
	conn, err := stringField(value, key)
	if err != nil {
		return err
	}
	if !sessionPattern.MatchString(conn) {
		return fmt.Errorf("invalid %s", key)
	}
	return nil
}

func symbolField(value map[string]any) error {
	return literalString(value, "symbol", "BTC-USD")
}

func validIntervalField(value map[string]any, key string) error {
	interval, err := stringField(value, key)
	if err != nil {
		return err
	}
	switch interval {
	case "1s", "1m", "5m":
		return nil
	default:
		return fmt.Errorf("invalid interval %q", interval)
	}
}

func tierField(value map[string]any, key string) error {
	tier, err := stringField(value, key)
	if err != nil {
		return err
	}
	if !isTier(tier) {
		return fmt.Errorf("invalid tier %q", tier)
	}
	return nil
}

func nullableTier(value any, key string) error {
	if value == nil {
		return nil
	}
	tier, ok := value.(string)
	if !ok || !isTier(tier) {
		return fmt.Errorf("invalid nullable tier %s", key)
	}
	return nil
}

func isTier(value string) bool {
	return value == "full" || value == "degraded" || value == "minimal"
}

func validSafeUint(value map[string]any, key string) error {
	_, err := safeUint(value[key], key, 0)
	return err
}

func validPositiveID(value map[string]any, key string) error {
	_, err := safeUint(value[key], key, 1)
	return err
}

func nullablePositiveID(value any, key string) error {
	if value == nil {
		return nil
	}
	_, err := safeUint(value, key, 1)
	return err
}

func validPositiveDuration(value map[string]any, key string, max uint64) error {
	n, err := safeUint(value[key], key, 1)
	if err != nil {
		return err
	}
	if n > max {
		return fmt.Errorf("%s exceeds maximum", key)
	}
	return nil
}

func safeUint(value any, key string, min uint64) (uint64, error) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || math.Trunc(number) != number || number > maxSafeInteger {
		return 0, fmt.Errorf("%s must be a safe unsigned integer", key)
	}
	n := uint64(number)
	if n < min {
		return 0, fmt.Errorf("%s is below minimum", key)
	}
	return n, nil
}

func numberRange(value any, key string, min, max float64) error {
	n, ok := value.(float64)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n < min || n > max {
		return fmt.Errorf("%s out of range", key)
	}
	return nil
}

func intRange(value any, key string, min, max int) error {
	_, err := boundedInt(value, key, min, max)
	return err
}

func boundedInt(value any, key string, min, max int) (int, error) {
	n, err := safeUint(value, key, uint64(min))
	if err != nil {
		return 0, err
	}
	if n > uint64(max) {
		return 0, fmt.Errorf("%s exceeds maximum", key)
	}
	return int(n), nil
}

func decimalLiteral(value map[string]any, key string, scale, maxLen int, positive bool) error {
	_, err := decimalScaled(value[key], key, scale, maxLen, positive)
	return err
}

func decimalScaled(value any, key string, scale, maxLen int, positive bool) (int64, error) {
	text, ok := value.(string)
	if !ok {
		return 0, fmt.Errorf("%s must be a decimal string", key)
	}
	if len(text) == 0 || len(text) > maxLen || !decimalPattern.MatchString(text) {
		return 0, fmt.Errorf("%s has invalid decimal syntax", key)
	}
	parts := strings.Split(text, ".")
	if len(parts) == 2 && len(parts[1]) > scale {
		return 0, fmt.Errorf("%s has excess precision", key)
	}
	whole := parts[0]
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	scaledText := whole + fraction + strings.Repeat("0", scale-len(fraction))
	scaled, err := strconv.ParseInt(scaledText, 10, 64)
	if err != nil || scaled > maxSafeInteger {
		return 0, fmt.Errorf("%s scaled value is unsafe", key)
	}
	if positive && scaled <= 0 {
		return 0, fmt.Errorf("%s must be positive", key)
	}
	return scaled, nil
}

func errorCode(value any, key string) error {
	code, ok := value.(string)
	if !ok {
		return fmt.Errorf("%s must be a string", key)
	}
	switch code {
	case "bad_request", "not_found", "method_not_allowed", "not_ready", "busy", "origin_denied", "rate_limited", "internal_error", "bad_message", "unknown_interval", "bad_request_id", "wrong_session", "debug_disabled", "capacity_reached":
		return nil
	default:
		return fmt.Errorf("invalid error code %q", code)
	}
}

func displayText(value any, key string) error {
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("%s must be a string", key)
	}
	if len([]rune(text)) < 1 || len([]rune(text)) > 160 || len([]byte(text)) > 640 {
		return fmt.Errorf("%s length out of bounds", key)
	}
	for _, r := range text {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%s contains a control character", key)
		}
	}
	return nil
}

func durationMap(root map[string]any, key string, fields ...string) (map[string]uint64, error) {
	m, err := mapField(root, key)
	if err != nil {
		return nil, err
	}
	if err := exactKeys(m, fields...); err != nil {
		return nil, err
	}
	out := make(map[string]uint64, len(fields))
	for _, field := range fields {
		n, err := safeUint(m[field], field, 1)
		if err != nil {
			return nil, err
		}
		if n > 3600000 {
			return nil, fmt.Errorf("%s exceeds maximum", field)
		}
		out[field] = n
	}
	return out, nil
}

func thresholdMap(root map[string]any, key string, fields ...string) (map[string]uint64, error) {
	return durationMap(root, key, fields...)
}
