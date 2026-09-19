package model

import "time"

const (
	DeliveryInitialTier = "degraded"

	DeliveryFlushFullMS     = 100
	DeliveryFlushDegradedMS = 500
	DeliveryFlushMinimalMS  = 2000

	DeliveryEnterDegradedLatencyMS = 400
	DeliveryEnterDegradedJitterMS  = 60
	DeliveryEnterMinimalLatencyMS  = 900
	DeliveryEnterMinimalJitterMS   = 150

	DeliveryRecoverFullLatencyMS     = 300
	DeliveryRecoverFullJitterMS      = 40
	DeliveryRecoverDegradedLatencyMS = 700
	DeliveryRecoverDegradedJitterMS  = 100

	DeliveryDowngradeDwell       = 3 * time.Second
	DeliveryUpgradeDwell         = 10 * time.Second
	DeliveryMissingReportStep    = 5 * time.Second
	DeliveryMissingReportMinimal = 12 * time.Second

	BrowserProbeEveryMS     = 1000
	BrowserPongTimeoutMS    = 3000
	BrowserReportEveryMS    = 2000
	BrowserRTTWindowSamples = 10

	DeliveryMinimumReportSamples = 2
	DeliveryMaximumReportSamples = 10
	DeliveryHiddenCloseAfter     = 180 * time.Second
)
