import {
  expectArray,
  expectBoundedSafeUint,
  expectDuration,
  expectExactString,
  expectObject,
  expectSessionId,
  expectSymbol,
  expectTier,
  intervals,
  parsePrice,
  validateDurationMap,
  validateThresholds,
  type WireRecord,
} from "./support";

export function validateMeta(value: unknown): WireRecord {
  const object = expectObject(value, [
    "session",
    "symbol",
    "tickSize",
    "lotSize",
    "intervals",
    "referencePrice",
    "tierPolicy",
    "retention",
  ]);
  const intervalsValue = expectArray(object.intervals, "intervals");
  if (
    intervalsValue.length !== intervals.length ||
    !intervals.every((interval, index) => intervalsValue[index] === interval)
  ) {
    throw new Error("invalid intervals");
  }

  return {
    session: expectSessionId(object.session, "session"),
    symbol: expectSymbol(object.symbol),
    tickSize: expectExactString(object.tickSize, "0.01", "tickSize"),
    lotSize: expectExactString(object.lotSize, "0.0001", "lotSize"),
    intervals: [...intervals],
    referencePrice: parsePrice(object.referencePrice).raw,
    tierPolicy: validateTierPolicy(object.tierPolicy),
    retention: validateRetention(object.retention),
  };
}

function validateTierPolicy(value: unknown): WireRecord {
  const object = expectObject(value, [
    "initialTier",
    "flushMs",
    "enterDegraded",
    "enterMinimal",
    "recoverFull",
    "recoverDegraded",
    "downgradeDwellMs",
    "upgradeDwellMs",
    "missingReportStepMs",
    "missingReportMinimalMs",
    "pingEveryMs",
    "pongTimeoutMs",
    "reportEveryMs",
    "rttWindowSamples",
    "minimumReportSamples",
    "hiddenCloseMs",
  ]);
  const flushMs = validateDurationMap(object.flushMs, "flushMs");
  const enterDegraded = validateThresholds(object.enterDegraded, "latencyAboveMs", "jitterAboveMs");
  const enterMinimal = validateThresholds(object.enterMinimal, "latencyAboveMs", "jitterAboveMs");
  const recoverFull = validateThresholds(object.recoverFull, "latencyBelowMs", "jitterBelowMs");
  const recoverDegraded = validateThresholds(object.recoverDegraded, "latencyBelowMs", "jitterBelowMs");
  const missingReportStepMs = expectDuration(object.missingReportStepMs, "missingReportStepMs");
  const missingReportMinimalMs = expectDuration(object.missingReportMinimalMs, "missingReportMinimalMs");
  const rttWindowSamples = expectBoundedSafeUint(object.rttWindowSamples, "rttWindowSamples", 2, 10);
  const minimumReportSamples = expectBoundedSafeUint(
    object.minimumReportSamples,
    "minimumReportSamples",
    2,
    10,
  );

  if (!(flushMs.full < flushMs.degraded && flushMs.degraded < flushMs.minimal)) {
    throw new Error("invalid flush order");
  }
  if (
    !(recoverFull.latencyBelowMs < enterDegraded.latencyAboveMs) ||
    !(recoverFull.jitterBelowMs < enterDegraded.jitterAboveMs) ||
    !(recoverDegraded.latencyBelowMs < enterMinimal.latencyAboveMs) ||
    !(recoverDegraded.jitterBelowMs < enterMinimal.jitterAboveMs)
  ) {
    throw new Error("invalid recovery thresholds");
  }
  if (
    !(enterMinimal.latencyAboveMs > enterDegraded.latencyAboveMs) ||
    !(enterMinimal.jitterAboveMs > enterDegraded.jitterAboveMs)
  ) {
    throw new Error("invalid entry thresholds");
  }
  if (!(missingReportMinimalMs > missingReportStepMs)) {
    throw new Error("invalid missing report timing");
  }
  if (minimumReportSamples > rttWindowSamples) {
    throw new Error("invalid report samples");
  }

  return {
    initialTier: expectTier(object.initialTier, "initialTier"),
    flushMs,
    enterDegraded,
    enterMinimal,
    recoverFull,
    recoverDegraded,
    downgradeDwellMs: expectDuration(object.downgradeDwellMs, "downgradeDwellMs"),
    upgradeDwellMs: expectDuration(object.upgradeDwellMs, "upgradeDwellMs"),
    missingReportStepMs,
    missingReportMinimalMs,
    pingEveryMs: expectDuration(object.pingEveryMs, "pingEveryMs"),
    pongTimeoutMs: expectDuration(object.pongTimeoutMs, "pongTimeoutMs"),
    reportEveryMs: expectDuration(object.reportEveryMs, "reportEveryMs"),
    rttWindowSamples,
    minimumReportSamples,
    hiddenCloseMs: expectDuration(object.hiddenCloseMs, "hiddenCloseMs"),
  };
}

function validateRetention(value: unknown): WireRecord {
  const object = expectObject(value, [
    "historyCandles",
    "deliveryClosedCandles",
    "recentTrades",
    "bookChanges",
    "maximumBookLevelsPerSide",
  ]);
  const historyCandles = expectObject(object.historyCandles, ["1s", "1m", "5m"]);

  return {
    historyCandles: {
      "1s": expectBoundedSafeUint(historyCandles["1s"], "historyCandles.1s", 1, 10000),
      "1m": expectBoundedSafeUint(historyCandles["1m"], "historyCandles.1m", 1, 10000),
      "5m": expectBoundedSafeUint(historyCandles["5m"], "historyCandles.5m", 1, 10000),
    },
    deliveryClosedCandles: expectBoundedSafeUint(object.deliveryClosedCandles, "deliveryClosedCandles", 1, 64),
    recentTrades: expectBoundedSafeUint(object.recentTrades, "recentTrades", 1, 200),
    bookChanges: expectBoundedSafeUint(object.bookChanges, "bookChanges", 1, 4096),
    maximumBookLevelsPerSide: expectBoundedSafeUint(
      object.maximumBookLevelsPerSide,
      "maximumBookLevelsPerSide",
      10,
      50,
    ),
  };
}
