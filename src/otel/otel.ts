import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  AggregationType,
  createAllowListAttributesProcessor,
  PeriodicExportingMetricReader,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BaggageSpanProcessor } from './baggage-span-processor.js';
import { PROPAGATED_BAGGAGE_KEYS } from './baggage-keys.js';

const diagLevelMap: Record<string, DiagLogLevel> = {
  WARN: DiagLogLevel.WARN,
  ERROR: DiagLogLevel.ERROR,
  NONE: DiagLogLevel.NONE,
};

const configuredDiagLevel = process.env.OTEL_DIAG_LOG_LEVEL?.toUpperCase();
if (configuredDiagLevel && diagLevelMap[configuredDiagLevel] !== undefined) {
  diag.setLogger(new DiagConsoleLogger(), diagLevelMap[configuredDiagLevel]);
} else if (process.env.NODE_ENV !== 'production') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
}

const traceExporter = new OTLPTraceExporter();
const metricExporter = new OTLPMetricExporter();
const logExporter = new OTLPLogExporter();

// Honor the standard OTEL_METRICS_EXPORTER=none (previously inert because we
// construct exporters explicitly). Staging sets it: its metrics only existed
// for load-test judgment, which the post-merge gate now does artillery-side,
// and every staging redeploy otherwise mints a fresh duplicate series set
// against Grafana Cloud's 10k free-tier active-series cap.
const metricsDisabled = process.env.OTEL_METRICS_EXPORTER === 'none';

// Series-identity control. Metric series identity in Grafana Cloud comes
// from service.name + service.instance.id; the SDK default instance id is a
// random UUID per process, so every redeploy strands a full duplicate
// series set until it ages out. With a SINGLE replica a constant id keeps
// series continuous across deploys.
// ⚠️ If this service ever runs >1 replica, set SERVICE_INSTANCE_ID to
// something per-replica (e.g. $RAILWAY_REPLICA_ID) — two replicas writing
// the same series id silently corrupt every counter.
// Env-qualified: deployment_environment is NOT part of metric series
// identity, so without the env suffix staging and production would write
// into the SAME series and corrupt each other's counters.
const serviceInstanceId =
  process.env.SERVICE_INSTANCE_ID ??
  `${process.env.OTEL_SERVICE_NAME ?? 'wabot-sketch'}-${
    process.env.ENV ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? 'development'
  }`;
// Injected via OTEL_RESOURCE_ATTRIBUTES (read by the SDK's env resource
// detector at start) rather than a Resource object — keeps otel.ts free of
// an extra @opentelemetry/resources import. An operator-provided
// service.instance.id in the env var wins.
if (!process.env.OTEL_RESOURCE_ATTRIBUTES?.includes('service.instance.id=')) {
  process.env.OTEL_RESOURCE_ATTRIBUTES = [
    process.env.OTEL_RESOURCE_ATTRIBUTES,
    `service.instance.id=${serviceInstanceId}`,
  ]
    .filter(Boolean)
    .join(',');
}

// Cardinality diet for the free-tier cap (10k active series). Dropped
// instruments were never queried in any digest/investigation:
// - http.client.* — two semconv generations of the same client-latency
//   histogram (~200 series); wabot→pp/Meta failures surface in logs.
// - v8js.gc.* — GC pause histogram (~75 series).
// - v8js heap-space breakdowns — only the totals are ever consulted, so
//   collapse the per-space attributes into a single series each.
const metricViews: ViewOptions[] = [
  {
    instrumentName: 'http.client.duration',
    aggregation: { type: AggregationType.DROP },
  },
  {
    instrumentName: 'http.client.request.duration',
    aggregation: { type: AggregationType.DROP },
  },
  {
    instrumentName: 'v8js.gc.duration',
    aggregation: { type: AggregationType.DROP },
  },
  {
    instrumentName: 'v8js.memory.heap.space.available_size',
    aggregation: { type: AggregationType.DROP },
  },
  {
    instrumentName: 'v8js.memory.heap.space.physical_size',
    aggregation: { type: AggregationType.DROP },
  },
  {
    instrumentName: 'v8js.memory.heap.used',
    attributesProcessors: [createAllowListAttributesProcessor([])],
  },
  {
    instrumentName: 'v8js.memory.heap.limit',
    attributesProcessors: [createAllowListAttributesProcessor([])],
  },
];

// CompositePropagator combines W3C TraceContext (default) with
// W3CBaggagePropagator so that padhaipal.load_test / padhaipal.test_phase
// (and any other baggage entries) serialize into the `baggage` HTTP
// header on outgoing requests and round-trip back through ingest queues.
// Without the baggage propagator, NodeSDK only carries the trace context
// across process boundaries and pp-sketch sees `load_test` as absent.
const textMapPropagator = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
});

// BaggageSpanProcessor first so padhaipal.* baggage entries land on each
// span as attributes before BatchSpanProcessor batches/exports the span.
const sdk = new NodeSDK({
  textMapPropagator,
  spanProcessors: [
    new BaggageSpanProcessor(PROPAGATED_BAGGAGE_KEYS),
    new BatchSpanProcessor(traceExporter),
  ],
  ...(metricsDisabled
    ? {}
    : {
        metricReader: new PeriodicExportingMetricReader({
          exporter: metricExporter,
        }),
        views: metricViews,
      }),
  logRecordProcessor: new BatchLogRecordProcessor(logExporter),
  // UndiciInstrumentation covers Node 18+'s global `fetch` (used by both
  // services for cross-process HTTP calls). The default auto-instrumentation
  // bundle only hooks the legacy `http`/`https` modules, missing all fetch
  // traffic — wabot → pp-sketch is undici-driven and was invisible without
  // this addition.
  instrumentations: [
    getNodeAutoInstrumentations(),
    new UndiciInstrumentation(),
  ],
});

try {
  sdk.start();
} catch (error: unknown) {
  const details =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  console.error(`OTel SDK failed to start: ${details}`);
}

let shutdownStarted = false;
const shutdown = (): void => {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  void sdk.shutdown().catch((error: unknown) => {
    const details =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);

    console.error(`OTel SDK failed to shutdown: ${details}`);
    process.exitCode = 1;
  });
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
