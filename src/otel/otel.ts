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
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
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
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
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
