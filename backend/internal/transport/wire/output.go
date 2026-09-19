package wire

import (
	"encoding/json"
	"errors"
	"spackt/internal/model"
	"spackt/internal/precision"
)

var ErrMessageTooLarge = errors.New("message exceeds byte budget")

// EncodeBounded checks bytes before any transport write.
func EncodeBounded(kind string, value map[string]any, limit int) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return nil, ErrMessageTooLarge
	}
	if _, err = Decode(kind, data); err != nil {
		return nil, err
	}
	return data, nil
}

func Levels(levels []model.Level) []any {
	out := make([]any, 0, len(levels))
	for _, level := range levels {
		out = append(out, []any{precision.FormatPrice(level.PriceTicks), precision.FormatQuantity(level.QuantityLots)})
	}
	return out
}
func Trades(trades []model.Trade) []any {
	out := make([]any, 0, len(trades))
	for _, trade := range trades {
		out = append(out, map[string]any{"id": trade.ID, "t": trade.TimeMS, "p": precision.FormatPrice(trade.PriceTicks), "q": precision.FormatQuantity(trade.QuantityLots), "side": trade.Side})
	}
	return out
}
func Candles(candles []model.Candle) []any {
	out := make([]any, 0, len(candles))
	for _, c := range candles {
		out = append(out, map[string]any{"t": c.TimeMS, "o": precision.FormatPrice(c.OpenTicks), "h": precision.FormatPrice(c.HighTicks), "l": precision.FormatPrice(c.LowTicks), "c": precision.FormatPrice(c.CloseTicks), "v": precision.FormatQuantity(c.VolumeLots), "rev": c.Rev, "closed": c.Closed})
	}
	return out
}
func BookResponse(c model.BookCapture) map[string]any {
	return map[string]any{"session": c.Session, "symbol": c.Symbol, "seq": c.Book.Seq, "t": c.TimeMS, "bids": Levels(c.Book.Bids), "asks": Levels(c.Book.Asks)}
}
func HistoryResponse(session string, interval model.CandleInterval, id uint64, candles []model.Candle) map[string]any {
	return map[string]any{"session": session, "symbol": "BTC-USD", "interval": string(interval), "requestId": id, "candles": Candles(candles)}
}
func TradesResponse(session string, trades []model.Trade) map[string]any {
	return map[string]any{"session": session, "symbol": "BTC-USD", "trades": reverseTrades(trades)}
}
func HTTPError(code, message string) map[string]any {
	return map[string]any{"error": map[string]any{"code": code, "message": message}}
}
func Health(ready bool) map[string]any {
	status := "ok"
	if !ready {
		status = "not_ready"
	}
	return map[string]any{"status": status}
}

func Metadata(pub model.Publication, bookChanges int) map[string]any {
	return map[string]any{
		"session": pub.Session, "symbol": pub.Symbol, "tickSize": "0.01", "lotSize": "0.0001", "intervals": []any{"1s", "1m", "5m"}, "referencePrice": precision.FormatPrice(pub.ReferencePriceTicks),
		"tierPolicy": map[string]any{
			"initialTier": "degraded", "flushMs": map[string]any{"full": 100, "degraded": 500, "minimal": 2000},
			"enterDegraded": map[string]any{"latencyAboveMs": 400, "jitterAboveMs": 60}, "enterMinimal": map[string]any{"latencyAboveMs": 900, "jitterAboveMs": 150},
			"recoverFull": map[string]any{"latencyBelowMs": 300, "jitterBelowMs": 40}, "recoverDegraded": map[string]any{"latencyBelowMs": 700, "jitterBelowMs": 100},
			"downgradeDwellMs": 3000, "upgradeDwellMs": 10000, "missingReportStepMs": 5000, "missingReportMinimalMs": 12000,
			"pingEveryMs": 1000, "pongTimeoutMs": 3000, "reportEveryMs": 2000, "rttWindowSamples": 10, "minimumReportSamples": 2, "hiddenCloseMs": 180000,
		},
		"retention": map[string]any{"historyCandles": map[string]any{"1s": 3600, "1m": 1440, "5m": 2016}, "deliveryClosedCandles": 64, "recentTrades": 200, "bookChanges": bookChanges, "maximumBookLevelsPerSide": 50},
	}
}

func reverseTrades(trades []model.Trade) []any {
	out := Trades(trades)
	for left, right := 0, len(out)-1; left < right; left, right = left+1, right-1 {
		out[left], out[right] = out[right], out[left]
	}
	return out
}
