package wire

import (
	"encoding/json"
	"errors"
	"spackt/internal/model"
	"spackt/internal/precision"
	"time"
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
			"initialTier": model.DeliveryInitialTier, "flushMs": map[string]any{"full": model.DeliveryFlushFullMS, "degraded": model.DeliveryFlushDegradedMS, "minimal": model.DeliveryFlushMinimalMS},
			"enterDegraded": map[string]any{"latencyAboveMs": model.DeliveryEnterDegradedLatencyMS, "jitterAboveMs": model.DeliveryEnterDegradedJitterMS}, "enterMinimal": map[string]any{"latencyAboveMs": model.DeliveryEnterMinimalLatencyMS, "jitterAboveMs": model.DeliveryEnterMinimalJitterMS},
			"recoverFull": map[string]any{"latencyBelowMs": model.DeliveryRecoverFullLatencyMS, "jitterBelowMs": model.DeliveryRecoverFullJitterMS}, "recoverDegraded": map[string]any{"latencyBelowMs": model.DeliveryRecoverDegradedLatencyMS, "jitterBelowMs": model.DeliveryRecoverDegradedJitterMS},
			"downgradeDwellMs": int(model.DeliveryDowngradeDwell / time.Millisecond), "upgradeDwellMs": int(model.DeliveryUpgradeDwell / time.Millisecond), "missingReportStepMs": int(model.DeliveryMissingReportStep / time.Millisecond), "missingReportMinimalMs": int(model.DeliveryMissingReportMinimal / time.Millisecond),
			"pingEveryMs": model.BrowserProbeEveryMS, "pongTimeoutMs": model.BrowserPongTimeoutMS, "reportEveryMs": model.BrowserReportEveryMS, "rttWindowSamples": model.BrowserRTTWindowSamples, "minimumReportSamples": model.DeliveryMinimumReportSamples, "hiddenCloseMs": int(model.DeliveryHiddenCloseAfter / time.Millisecond),
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
