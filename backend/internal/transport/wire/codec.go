package wire

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"spackt/internal/model"
	"unicode/utf8"
)

const (
	maxClientBytes = 4096
	maxServerBytes = 1024 * 1024
	maxRESTBytes   = 2 * 1024 * 1024
	maxSafeInteger = 9007199254740991
	maxDepth       = 12
)

func Decode(kind string, data []byte) (map[string]any, error) {
	if !supportedKind(kind) {
		return nil, fmt.Errorf("unsupported kind %q", kind)
	}
	if len(data) > byteLimit(kind) {
		return nil, fmt.Errorf("%s message exceeds %d bytes", kind, byteLimit(kind))
	}
	if !utf8.Valid(data) {
		return nil, errors.New("message is not valid utf-8")
	}
	if err := checkJSONDepth(data); err != nil {
		return nil, err
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var decoded any
	if err := dec.Decode(&decoded); err != nil {
		return nil, err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return nil, errors.New("trailing JSON data")
	}

	value, err := normalizeJSON(decoded)
	if err != nil {
		return nil, err
	}
	root, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("root must be an object")
	}
	if err := validate(kind, root); err != nil {
		return nil, err
	}
	return root, nil
}

func Encode(kind string, value any) ([]byte, error) {
	if !supportedKind(kind) {
		return nil, fmt.Errorf("unsupported kind %q", kind)
	}
	normalized, err := normalizeRuntime(value, make(map[visitKey]bool))
	if err != nil {
		return nil, err
	}
	root, ok := normalized.(map[string]any)
	if !ok {
		return nil, errors.New("root must be an object")
	}
	if err := validate(kind, root); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return nil, err
	}
	if len(encoded) > byteLimit(kind) {
		return nil, fmt.Errorf("%s message exceeds %d bytes", kind, byteLimit(kind))
	}
	return encoded, nil
}

func ToTrade(value map[string]any) (model.Trade, error) {
	if err := validateTrade(value, true); err != nil {
		return model.Trade{}, err
	}
	id, _ := safeUint(value["id"], "id", 1)
	t, _ := safeUint(value["t"], "t", 0)
	price, _ := decimalScaled(value["p"], "p", 2, 16, true)
	quantity, _ := decimalScaled(value["q"], "q", 4, 18, true)
	side, _ := stringField(value, "side")
	return model.Trade{
		ID:           uint64(id),
		TimeMS:       int64(t),
		PriceTicks:   int64(price),
		QuantityLots: int64(quantity),
		Side:         side,
	}, nil
}

func supportedKind(kind string) bool {
	switch kind {
	case "client", "server", "meta", "book", "history", "trades", "httpError", "health", "readiness":
		return true
	default:
		return false
	}
}

func byteLimit(kind string) int {
	switch kind {
	case "client":
		return maxClientBytes
	case "server":
		return maxServerBytes
	default:
		return maxRESTBytes
	}
}

func validate(kind string, root map[string]any) error {
	switch kind {
	case "client":
		return validateClient(root)
	case "server":
		return validateServer(root)
	case "meta":
		return validateMeta(root)
	case "book":
		return validateBook(root, true)
	case "history":
		return validateHistory(root)
	case "trades":
		return validateRecentTrades(root)
	case "httpError":
		return validateHTTPError(root)
	case "health":
		return validateStatus(root, "ok")
	case "readiness":
		return validateStatus(root, "ok", "not_ready")
	default:
		return fmt.Errorf("unsupported kind %q", kind)
	}
}

func normalizeJSON(value any) (any, error) {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			normalized, err := normalizeJSON(item)
			if err != nil {
				return nil, err
			}
			out[key] = normalized
		}
		return out, nil
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			normalized, err := normalizeJSON(item)
			if err != nil {
				return nil, err
			}
			out[i] = normalized
		}
		return out, nil
	case json.Number:
		n, err := v.Float64()
		if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
			return nil, fmt.Errorf("invalid number %q", v.String())
		}
		return n, nil
	default:
		return value, nil
	}
}

type visitKey struct {
	kind reflect.Kind
	ptr  uintptr
}

func normalizeRuntime(value any, seen map[visitKey]bool) (any, error) {
	switch v := value.(type) {
	case map[string]any:
		key := visitKey{kind: reflect.Map, ptr: reflect.ValueOf(v).Pointer()}
		if seen[key] {
			return nil, errors.New("cycle in object")
		}
		seen[key] = true
		out := make(map[string]any, len(v))
		for key, item := range v {
			normalized, err := normalizeRuntime(item, seen)
			if err != nil {
				return nil, err
			}
			out[key] = normalized
		}
		delete(seen, key)
		return out, nil
	case []any:
		key := visitKey{kind: reflect.Slice, ptr: reflect.ValueOf(v).Pointer()}
		if seen[key] {
			return nil, errors.New("cycle in array")
		}
		seen[key] = true
		out := make([]any, len(v))
		for i, item := range v {
			normalized, err := normalizeRuntime(item, seen)
			if err != nil {
				return nil, err
			}
			out[i] = normalized
		}
		delete(seen, key)
		return out, nil
	case json.Number:
		return normalizeJSON(v)
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, errors.New("non-finite number")
		}
		return v, nil
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, errors.New("non-finite number")
		}
		return f, nil
	case int:
		return float64(v), nil
	case int64:
		return float64(v), nil
	case uint64:
		return float64(v), nil
	default:
		return value, nil
	}
}

func checkJSONDepth(data []byte) error {
	depth := 0
	inString := false
	escaped := false
	for _, b := range data {
		if inString {
			if escaped {
				escaped = false
				continue
			}
			switch b {
			case '\\':
				escaped = true
			case '"':
				inString = false
			}
			continue
		}
		switch b {
		case '"':
			inString = true
		case '{', '[':
			depth++
			if depth > maxDepth {
				return fmt.Errorf("JSON depth exceeds %d", maxDepth)
			}
		case '}', ']':
			depth--
			if depth < 0 {
				return errors.New("malformed JSON")
			}
		}
	}
	return nil
}
