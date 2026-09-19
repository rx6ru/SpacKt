package wire

import (
	"errors"
	"fmt"
)

func validateMeta(root map[string]any) error {
	if err := exactKeys(root, "session", "symbol", "tickSize", "lotSize", "intervals", "referencePrice", "tierPolicy", "retention"); err != nil {
		return err
	}
	if err := all(sessionField(root), symbolField(root), decimalLiteral(root, "tickSize", 2, 16, true), decimalLiteral(root, "lotSize", 4, 18, true), decimalLiteral(root, "referencePrice", 2, 16, true)); err != nil {
		return err
	}
	intervals, err := arrayField(root, "intervals")
	if err != nil {
		return err
	}
	if len(intervals) != 3 || intervals[0] != "1s" || intervals[1] != "1m" || intervals[2] != "5m" {
		return errors.New("intervals must be [1s,1m,5m]")
	}
	policy, err := mapField(root, "tierPolicy")
	if err != nil {
		return err
	}
	if err := validateTierPolicy(policy); err != nil {
		return err
	}
	retention, err := mapField(root, "retention")
	if err != nil {
		return err
	}
	return validateRetention(retention)
}

func validateTierPolicy(policy map[string]any) error {
	keys := []string{"initialTier", "flushMs", "enterDegraded", "enterMinimal", "recoverFull", "recoverDegraded", "downgradeDwellMs", "upgradeDwellMs", "missingReportStepMs", "missingReportMinimalMs", "pingEveryMs", "pongTimeoutMs", "reportEveryMs", "rttWindowSamples", "minimumReportSamples", "hiddenCloseMs"}
	if err := exactKeys(policy, keys...); err != nil {
		return err
	}
	if err := tierField(policy, "initialTier"); err != nil {
		return err
	}
	flush, err := durationMap(policy, "flushMs", "full", "degraded", "minimal")
	if err != nil {
		return err
	}
	if !(flush["full"] < flush["degraded"] && flush["degraded"] < flush["minimal"]) {
		return errors.New("flushMs must increase from full to minimal")
	}
	enterD, err := thresholdMap(policy, "enterDegraded", "latencyAboveMs", "jitterAboveMs")
	if err != nil {
		return err
	}
	enterM, err := thresholdMap(policy, "enterMinimal", "latencyAboveMs", "jitterAboveMs")
	if err != nil {
		return err
	}
	recoverF, err := thresholdMap(policy, "recoverFull", "latencyBelowMs", "jitterBelowMs")
	if err != nil {
		return err
	}
	recoverD, err := thresholdMap(policy, "recoverDegraded", "latencyBelowMs", "jitterBelowMs")
	if err != nil {
		return err
	}
	if !(recoverF["latencyBelowMs"] < enterD["latencyAboveMs"] && recoverF["jitterBelowMs"] < enterD["jitterAboveMs"]) {
		return errors.New("recoverFull thresholds must be below enterDegraded")
	}
	if !(recoverD["latencyBelowMs"] < enterM["latencyAboveMs"] && recoverD["jitterBelowMs"] < enterM["jitterAboveMs"]) {
		return errors.New("recoverDegraded thresholds must be below enterMinimal")
	}
	if !(enterM["latencyAboveMs"] > enterD["latencyAboveMs"] && enterM["jitterAboveMs"] > enterD["jitterAboveMs"]) {
		return errors.New("minimal entry thresholds must exceed degraded entry thresholds")
	}
	for _, key := range []string{"downgradeDwellMs", "upgradeDwellMs", "missingReportStepMs", "missingReportMinimalMs", "pingEveryMs", "pongTimeoutMs", "reportEveryMs", "hiddenCloseMs"} {
		if err := validPositiveDuration(policy, key, 3600000); err != nil {
			return err
		}
	}
	step, _ := safeUint(policy["missingReportStepMs"], "missingReportStepMs", 1)
	minimal, _ := safeUint(policy["missingReportMinimalMs"], "missingReportMinimalMs", 1)
	if minimal <= step {
		return errors.New("missingReportMinimalMs must exceed missingReportStepMs")
	}
	rtt, err := boundedInt(policy["rttWindowSamples"], "rttWindowSamples", 2, 10)
	if err != nil {
		return err
	}
	minSamples, err := boundedInt(policy["minimumReportSamples"], "minimumReportSamples", 2, 10)
	if err != nil {
		return err
	}
	if minSamples > rtt {
		return errors.New("minimumReportSamples must not exceed rttWindowSamples")
	}
	return nil
}

func validateRetention(retention map[string]any) error {
	if err := exactKeys(retention, "historyCandles", "deliveryClosedCandles", "recentTrades", "bookChanges", "maximumBookLevelsPerSide"); err != nil {
		return err
	}
	history, err := mapField(retention, "historyCandles")
	if err != nil {
		return err
	}
	if err := exactKeys(history, "1s", "1m", "5m"); err != nil {
		return err
	}
	for _, key := range []string{"1s", "1m", "5m"} {
		if err := intRange(history[key], key, 1, 10000); err != nil {
			return err
		}
	}
	return all(intRange(retention["deliveryClosedCandles"], "deliveryClosedCandles", 1, 64), intRange(retention["recentTrades"], "recentTrades", 1, 200), intRange(retention["bookChanges"], "bookChanges", 1, 4096), intRange(retention["maximumBookLevelsPerSide"], "maximumBookLevelsPerSide", 10, 50))
}

func validateBook(root map[string]any, snapshot bool) error {
	if err := exactKeys(root, "session", "symbol", "seq", "t", "bids", "asks"); err != nil {
		return err
	}
	if err := all(sessionField(root), symbolField(root), validSafeUint(root, "seq"), validSafeUint(root, "t")); err != nil {
		return err
	}
	bids, err := arrayField(root, "bids")
	if err != nil {
		return err
	}
	asks, err := arrayField(root, "asks")
	if err != nil {
		return err
	}
	minDepth := 0
	if snapshot {
		minDepth = 10
	}
	if err := validateLevels(bids, minDepth, 50, true, true, true); err != nil {
		return err
	}
	if err := validateLevels(asks, minDepth, 50, true, true, false); err != nil {
		return err
	}
	if len(bids) > 0 && len(asks) > 0 {
		bestBid, _ := levelPrice(bids[0])
		bestAsk, _ := levelPrice(asks[0])
		if bestBid >= bestAsk {
			return errors.New("book sides cross")
		}
	}
	return nil
}

func validateBookRange(book map[string]any) error {
	if err := exactKeys(book, "from", "to", "bids", "asks"); err != nil {
		return err
	}
	from, err := safeUint(book["from"], "from", 1)
	if err != nil {
		return err
	}
	to, err := safeUint(book["to"], "to", 1)
	if err != nil {
		return err
	}
	if from > to {
		return errors.New("book range from exceeds to")
	}
	bids, err := arrayField(book, "bids")
	if err != nil {
		return err
	}
	asks, err := arrayField(book, "asks")
	if err != nil {
		return err
	}
	if len(bids)+len(asks) < 1 || len(bids)+len(asks) > 4096 {
		return errors.New("book range change count out of bounds")
	}
	if err := validateLevels(bids, 0, 4096, false, false, true); err != nil {
		return err
	}
	return validateLevels(asks, 0, 4096, false, false, false)
}

func validateHistory(root map[string]any) error {
	if err := exactKeys(root, "session", "symbol", "interval", "requestId", "candles"); err != nil {
		return err
	}
	if err := all(sessionField(root), symbolField(root), validIntervalField(root, "interval"), validSafeUint(root, "requestId")); err != nil {
		return err
	}
	candles, err := arrayField(root, "candles")
	if err != nil {
		return err
	}
	interval, _ := stringField(root, "interval")
	return validateCandles(candles, 0, 1000, false, 0, intervalMillis(interval))
}

func validateRecentTrades(root map[string]any) error {
	if err := exactKeys(root, "session", "symbol", "trades"); err != nil {
		return err
	}
	if err := all(sessionField(root), symbolField(root)); err != nil {
		return err
	}
	trades, err := arrayField(root, "trades")
	if err != nil {
		return err
	}
	return validateTradeList(trades, 0, 100, true)
}

func validateHTTPError(root map[string]any) error {
	if err := exactKeys(root, "error"); err != nil {
		return err
	}
	envelope, err := mapField(root, "error")
	if err != nil {
		return err
	}
	if err := exactKeys(envelope, "code", "message"); err != nil {
		return err
	}
	return all(errorCode(envelope["code"], "code"), displayText(envelope["message"], "message"))
}

func validateStatus(root map[string]any, allowed ...string) error {
	if err := exactKeys(root, "status"); err != nil {
		return err
	}
	status, err := stringField(root, "status")
	if err != nil {
		return err
	}
	for _, item := range allowed {
		if status == item {
			return nil
		}
	}
	return fmt.Errorf("invalid status %q", status)
}
