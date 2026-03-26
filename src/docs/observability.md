Logging
- use structured JSON.

INFO logs high-level milestones / business events
- webhook accepted
- job enqueued
- job completed
- outbound message sent

WARN logs first failure, fallback failure or third party failure
- transient provider failure
- malformed third-party request
- third party timeout response or error response

ERROR logs terminal failure
- final fallback failed
- SLO violation

Service Level Objectives
- 99.9% of wabot message responses occur ≤ 25 seconds after user submitted their message

Metrics
- wabot.message.e2e_duration_ms (Histogram): end-to-end milliseconds from WhatsApp message timestamp to wabot processing completion. Attributes: outcome ("success", "fallback"). Exported via OTLP.

Emit OpenTelemetry
- enable auto-instrumentation for HTTP / Express / Node libraries
- create manual spans around queues + important business logic
- export telemetry via OTLP to internal collector
- ensure there is no PII data in logs/metrics/trace/span
- keep metrics very minimal. Only capture the very most important SLO metrics.

Tracing rules
- inbound webhook request = root span
- BullMQ worker execution = span
