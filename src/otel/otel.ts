import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

const diagLevelMap: Record<string, DiagLogLevel> = {
  ALL: DiagLogLevel.ALL,
  VERBOSE: DiagLogLevel.VERBOSE,
  DEBUG: DiagLogLevel.DEBUG,
  INFO: DiagLogLevel.INFO,
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

const sdk = new NodeSDK({
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
  }),
  logRecordProcessor: new BatchLogRecordProcessor(logExporter),
  instrumentations: [getNodeAutoInstrumentations()],
});

try {
  sdk.start();
} catch (error: unknown) {
  const details =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // eslint-disable-next-line no-console
  console.error(`OTel SDK failed to start: ${details}`);
}

let shutdownStarted = false;
const shutdown = (): void => {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  void sdk
    .shutdown()
    .catch((error: unknown) => {
      const details =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // eslint-disable-next-line no-console
      console.error(`OTel SDK failed to shutdown: ${details}`);
      process.exitCode = 1;
    });
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
