package wire

import (
	"errors"
	"fmt"
)

func validateClient(root map[string]any) error {
	typ, err := commonTyped(root)
	if err != nil {
		return err
	}
	switch typ {
	case "subscribe":
		if err := exactKeys(root, "type", "session", "interval", "requestId"); err != nil {
			return err
		}
		return all(validIntervalField(root, "interval"), validPositiveID(root, "requestId"))
	case "ping":
		if err := exactKeys(root, "type", "session", "id"); err != nil {
			return err
		}
		return validPositiveID(root, "id")
	case "report":
		if err := exactKeys(root, "type", "session", "latencyMs", "jitterMs", "samples"); err != nil {
			return err
		}
		return all(numberRange(root["latencyMs"], "latencyMs", 0, 60000), numberRange(root["jitterMs"], "jitterMs", 0, 60000), intRange(root["samples"], "samples", 2, 10))
	case "visibility":
		if err := exactKeys(root, "type", "session", "hidden"); err != nil {
			return err
		}
		return boolFieldOnly(root, "hidden")
	case "debug":
		return validateClientDebug(root)
	default:
		return fmt.Errorf("unknown client type %q", typ)
	}
}

func validateClientDebug(root map[string]any) error {
	action, err := stringField(root, "action")
	if err != nil {
		return err
	}
	switch action {
	case "forceTier":
		if err := exactKeys(root, "type", "session", "action", "value"); err != nil {
			return err
		}
		value, err := stringField(root, "value")
		if err != nil {
			return err
		}
		if value != "auto" && !isTier(value) {
			return fmt.Errorf("invalid tier %q", value)
		}
	case "pongDelay":
		if err := exactKeys(root, "type", "session", "action", "value"); err != nil {
			return err
		}
		return intRange(root["value"], "value", 0, 4000)
	case "dropNextBookDelta", "disconnect":
		if err := exactKeys(root, "type", "session", "action"); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown debug action %q", action)
	}
	return nil
}

func validateServer(root map[string]any) error {
	typ, err := commonTyped(root)
	if err != nil {
		return err
	}
	switch typ {
	case "hello":
		if err := exactKeys(root, "type", "v", "session", "symbol", "connId", "tier", "autoTier", "forced", "hidden", "flushMs"); err != nil {
			return err
		}
		return all(intRange(root["v"], "v", 1, 1), symbolField(root), connectionField(root, "connId"), tierField(root, "tier"), tierField(root, "autoTier"), nullableTier(root["forced"], "forced"), boolFieldOnly(root, "hidden"), validPositiveDuration(root, "flushMs", 3600000))
	case "subscribed":
		if err := exactKeys(root, "type", "session", "interval", "requestId"); err != nil {
			return err
		}
		return all(validIntervalField(root, "interval"), validPositiveID(root, "requestId"))
	case "pong":
		if err := exactKeys(root, "type", "session", "id"); err != nil {
			return err
		}
		return validPositiveID(root, "id")
	case "tier":
		if err := exactKeys(root, "type", "session", "tier", "autoTier", "forced", "hidden", "flushMs", "reason"); err != nil {
			return err
		}
		return all(tierField(root, "tier"), tierField(root, "autoTier"), nullableTier(root["forced"], "forced"), boolFieldOnly(root, "hidden"), validPositiveDuration(root, "flushMs", 3600000), displayText(root["reason"], "reason"))
	case "heartbeat":
		if err := exactKeys(root, "type", "session", "marketRev", "bookSeq", "candleRequestId", "candleLatestRev", "feedReady"); err != nil {
			return err
		}
		if root["candleRequestId"] == nil && root["candleLatestRev"] != nil {
			return errors.New("candleLatestRev must be null when candleRequestId is null")
		}
		return all(validSafeUint(root, "marketRev"), validSafeUint(root, "bookSeq"), nullablePositiveID(root["candleRequestId"], "candleRequestId"), nullablePositiveID(root["candleLatestRev"], "candleLatestRev"), boolFieldOnly(root, "feedReady"))
	case "book_reset":
		if err := exactKeys(root, "type", "session", "reason"); err != nil {
			return err
		}
		return literalString(root, "reason", "cursor_expired")
	case "candles_reset":
		if err := exactKeys(root, "type", "session", "requestId", "interval", "reason"); err != nil {
			return err
		}
		return all(validPositiveID(root, "requestId"), validIntervalField(root, "interval"), literalString(root, "reason", "cursor_expired"))
	case "error":
		if err := exactKeys(root, "type", "session", "code", "message"); err != nil {
			return err
		}
		return all(errorCode(root["code"], "code"), displayText(root["message"], "message"))
	case "update":
		return validateUpdate(root)
	default:
		return fmt.Errorf("unknown server type %q", typ)
	}
}

func validateUpdate(root map[string]any) error {
	if err := optionalExactKeys(root, []string{"type", "session", "marketRev"}, []string{"book", "candles", "trades", "skipped"}); err != nil {
		return err
	}
	if err := validPositiveID(root, "marketRev"); err != nil {
		return err
	}
	_, hasBook := root["book"]
	_, hasCandles := root["candles"]
	_, hasTrades := root["trades"]
	_, hasSkipped := root["skipped"]
	if !hasBook && !hasCandles && !hasTrades {
		return errors.New("update requires a market payload")
	}
	if hasBook {
		book, err := mapField(root, "book")
		if err != nil {
			return err
		}
		if err := validateBookRange(book); err != nil {
			return err
		}
	}
	if hasCandles {
		candles, err := mapField(root, "candles")
		if err != nil {
			return err
		}
		marketRev, _ := safeUint(root["marketRev"], "marketRev", 1)
		if err := validateCandleBatch(candles, marketRev); err != nil {
			return err
		}
	}
	if hasTrades {
		trades, err := arrayField(root, "trades")
		if err != nil {
			return err
		}
		if err := validateTradeList(trades, 1, 50, false); err != nil {
			return err
		}
		if !hasSkipped {
			return errors.New("skipped is required with trades")
		}
		if _, err := safeUint(root["skipped"], "skipped", 0); err != nil {
			return err
		}
	} else if hasSkipped {
		return errors.New("skipped is only allowed with trades")
	}
	return nil
}
