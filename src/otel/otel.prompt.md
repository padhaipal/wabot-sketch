This file initializes the OpenTelemetry SDK for this repository.
It MUST be imported at the very top of main.ts, before any other imports (including NestJS).
OTel auto-instrumentation will automatically create spans for all inbound HTTP requests and outbound HTTP calls.

Architecture:
  wabot (this NestJS service on Railway) → OTLP/HTTP → Grafana Alloy (separate Railway service) → Grafana Cloud

NPM dependencies to install:
  @opentelemetry/sdk-node
  @opentelemetry/api
  @opentelemetry/auto-instrumentations-node
  @opentelemetry/exporter-trace-otlp-proto
  @opentelemetry/exporter-metrics-otlp-proto
  @opentelemetry/exporter-logs-otlp-proto
  @opentelemetry/sdk-metrics
  @opentelemetry/sdk-logs

Implementation — export a side-effect-only module (no default export needed):

1.) Create a NodeSDK instance from @opentelemetry/sdk-node with:
   * traceExporter: new OTLPTraceExporter() — reads OTEL_EXPORTER_OTLP_ENDPOINT automatically.
   * metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }).
   * logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()).
   * instrumentations: [getNodeAutoInstrumentations()] — auto-instruments HTTP, Express, dns, net, etc.

2.) Call sdk.start().

3.) Register graceful shutdown:
   * process.on('SIGTERM', () => { sdk.shutdown().then(() => process.exit(0), () => process.exit(1)); });

All configuration is driven by environment variables that the OTel SDK and OTLP exporters read automatically:
  * OTEL_SERVICE_NAME — identifies this service in Grafana dashboards (e.g. "wabot").
  * OTEL_EXPORTER_OTLP_ENDPOINT — the Grafana Alloy OTLP receiver URL (e.g. "http://alloy.railway.internal:4318").
  * OTEL_TRACES_EXPORTER — set to "otlp".
  * OTEL_METRICS_EXPORTER — set to "otlp".
  * OTEL_LOGS_EXPORTER — set to "otlp".
  * OTEL_RESOURCE_ATTRIBUTES — e.g. "deployment.environment=production".
  * OTEL_EXPORTER_OTLP_PROTOCOL — set to "http/protobuf".

Note: since the OTLP exporters read OTEL_EXPORTER_OTLP_ENDPOINT from the environment, no endpoint URLs are hardcoded in this file.
