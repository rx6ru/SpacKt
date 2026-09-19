package wire

import "spackt/internal/model"

type PolicyValues struct {
	Tier     string
	AutoTier string
	Forced   *string
	Hidden   bool
	FlushMS  int
	Reason   string
}

type BookValues struct {
	From, To   uint64
	Bids, Asks []model.Level
}
type CandleValues struct {
	RequestID uint64
	Interval  model.CandleInterval
	Items     []model.Candle
}
type UpdateValues struct {
	MarketRev uint64
	Book      *BookValues
	Candles   *CandleValues
	Trades    []model.Trade
	Skipped   uint64
}

func serverObject(kind, session string) map[string]any {
	return map[string]any{"type": kind, "session": session}
}
func policyObject(kind, session string, values PolicyValues) map[string]any {
	out := serverObject(kind, session)
	var forced any
	if values.Forced != nil {
		forced = *values.Forced
	}
	out["tier"], out["autoTier"], out["forced"], out["hidden"], out["flushMs"] = values.Tier, values.AutoTier, forced, values.Hidden, values.FlushMS
	return out
}
func HelloMessage(session, connID string, values PolicyValues) map[string]any {
	out := policyObject("hello", session, values)
	out["v"], out["symbol"], out["connId"] = 1, "BTC-USD", connID
	return out
}
func TierMessage(session string, values PolicyValues) map[string]any {
	out := policyObject("tier", session, values)
	out["reason"] = values.Reason
	return out
}
func PongMessage(session string, id uint64) map[string]any {
	out := serverObject("pong", session)
	out["id"] = id
	return out
}
func SubscribedMessage(session string, interval model.CandleInterval, id uint64) map[string]any {
	out := serverObject("subscribed", session)
	out["interval"], out["requestId"] = string(interval), id
	return out
}
func BookResetMessage(session, reason string) map[string]any {
	out := serverObject("book_reset", session)
	out["reason"] = reason
	return out
}
func CandleResetMessage(session string, interval model.CandleInterval, id uint64, reason string) map[string]any {
	out := serverObject("candles_reset", session)
	out["interval"], out["requestId"], out["reason"] = string(interval), id, reason
	return out
}
func ErrorMessage(session, code, message string) map[string]any {
	out := serverObject("error", session)
	out["code"], out["message"] = code, message
	return out
}
func HeartbeatMessage(session string, marketRev, bookSeq uint64, requestID, latestRev *uint64, ready bool) map[string]any {
	out := serverObject("heartbeat", session)
	var request, revision any
	if requestID != nil {
		request = *requestID
	}
	if latestRev != nil {
		revision = *latestRev
	}
	out["marketRev"], out["bookSeq"], out["candleRequestId"], out["candleLatestRev"], out["feedReady"] = marketRev, bookSeq, request, revision, ready
	return out
}
func UpdateMessage(session string, values UpdateValues) map[string]any {
	out := serverObject("update", session)
	out["marketRev"] = values.MarketRev
	if b := values.Book; b != nil {
		out["book"] = map[string]any{"from": b.From, "to": b.To, "bids": Levels(b.Bids), "asks": Levels(b.Asks)}
	}
	if c := values.Candles; c != nil {
		out["candles"] = map[string]any{"interval": string(c.Interval), "requestId": c.RequestID, "items": Candles(c.Items)}
	}
	if len(values.Trades) > 0 {
		out["trades"], out["skipped"] = Trades(values.Trades), values.Skipped
	}
	return out
}
