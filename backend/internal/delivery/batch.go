package delivery

import (
	"sort"
	"spackt/internal/model"
)

func buildBookRange(pub model.Publication, sent uint64) (*BookRange, bool) {
	if pub.Book.Seq <= sent {
		return nil, false
	}
	changes := pub.BookChanges
	if len(changes) == 0 || changes[0].Seq > sent+1 {
		return nil, true
	}
	bids, asks := map[int64]int64{}, map[int64]int64{}
	expected := sent + 1
	for _, change := range changes {
		if change.Seq <= sent {
			continue
		}
		if change.Seq != expected || change.Seq > pub.Book.Seq {
			return nil, true
		}
		expected++
		if change.Side == model.BookSideBid {
			bids[change.PriceTicks] = change.QuantityLots
		} else {
			asks[change.PriceTicks] = change.QuantityLots
		}
	}
	if expected != pub.Book.Seq+1 {
		return nil, true
	}
	return &BookRange{From: sent + 1, To: pub.Book.Seq, Bids: orderedLevels(bids, true), Asks: orderedLevels(asks, false)}, false
}

func orderedLevels(values map[int64]int64, descending bool) []model.Level {
	levels := make([]model.Level, 0, len(values))
	for price, quantity := range values {
		levels = append(levels, model.Level{PriceTicks: price, QuantityLots: quantity})
	}
	sort.Slice(levels, func(i, j int) bool {
		if descending {
			return levels[i].PriceTicks > levels[j].PriceTicks
		}
		return levels[i].PriceTicks < levels[j].PriceTicks
	})
	return levels
}

func changedCandles(candles []model.Candle, cursor Cursors) ([]model.Candle, bool) {
	if len(candles) == 0 {
		return nil, false
	}
	if cursor.CandleRev == 0 {
		return []model.Candle{candles[len(candles)-1]}, false
	}
	if cursor.CandleStartMS < candles[0].TimeMS {
		return nil, true
	}
	var changed []model.Candle
	for _, candle := range candles {
		if candle.TimeMS > cursor.CandleStartMS || (candle.TimeMS == cursor.CandleStartMS && candle.Rev > cursor.CandleRev) {
			changed = append(changed, candle)
		}
	}
	return changed, false
}

func unseenTrades(pub model.Publication, sent uint64) ([]model.Trade, uint64) {
	if pub.LastTradeID <= sent {
		return nil, 0
	}
	var trades []model.Trade
	for _, trade := range pub.Trades {
		if trade.ID > sent {
			trades = append(trades, trade)
		}
	}
	if len(trades) > 50 {
		trades = trades[len(trades)-50:]
	}
	if len(trades) == 0 {
		return nil, 0
	}
	return trades, pub.LastTradeID - sent - uint64(len(trades))
}

func cloneFrames(frames []Frame) []Frame {
	out := make([]Frame, len(frames))
	for i, frame := range frames {
		if frame.Subscribed != nil {
			copied := *frame.Subscribed
			frame.Subscribed = &copied
		}
		if frame.BookReset != nil {
			copied := *frame.BookReset
			frame.BookReset = &copied
		}
		if frame.CandlesReset != nil {
			copied := *frame.CandlesReset
			frame.CandlesReset = &copied
		}
		if frame.Book != nil {
			copied := *frame.Book
			copied.Bids = append([]model.Level{}, copied.Bids...)
			copied.Asks = append([]model.Level{}, copied.Asks...)
			frame.Book = &copied
		}
		if frame.Candles != nil {
			copied := *frame.Candles
			copied.Items = append([]model.Candle{}, copied.Items...)
			frame.Candles = &copied
		}
		frame.Trades = append([]model.Trade{}, frame.Trades...)
		out[i] = frame
	}
	return out
}
