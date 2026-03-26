SLO metric for the 25-second message response target (see docs/observability.md).

wabot.message.e2e_duration_ms (Histogram)
* Recorded at the end of processMessage in message.processor.ts.
* Value: Date.now() − (message.timestamp × 1000).
* Attributes: outcome ("success", "fallback").
