1.) Start the trace with code like that shown below. The span name will be wabot.ingress, log an INFO. The `throw err` in this span will return a 5XX https response and log an ERROR.


import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("whatsapp-bot");

await tracer.startActiveSpan("...", async (span) => {
  try {
    span.setAttribute("...");
    // ... 
  } catch (err: any) {
    span.recordException(...);
    span.setStatus(...);
    throw err;
  } finally {
    span.end(); // always end the span
  }
});

2.) Call wa-handle-ingress.service.ts and send it's return value as the https response to WhatsApp servers. Pass in the HTTPS header X-Hub-Signature-256, the HTTPS header Content-Length, the HTTPS json payload, the trace and span information.

3.) End the span.

Observability architecture:
wabot-sketch and pp-sketch export logs/metrics/traces via OpenTelemetry (OTLP) to a separate Railway service running Grafana Alloy. Alloy forwards everything to Grafana Cloud. The `@opentelemetry/api` imports and `../otel/metrics` module referenced in these prompts assume this OTLP pipeline is configured at app startup.
