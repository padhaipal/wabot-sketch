Bridges NestJS Logger to the OTel Logs API so all application logs flow to Grafana Cloud Loki via OTLP.

Extends ConsoleLogger so console output is preserved (NestJS formatting, timestamps, colours).
Each log level (log, error, warn, debug, verbose, fatal) calls super first, then emits an OTel log record.

OTel log record shape:
* severityNumber / severityText: mapped from NestJS log level.
* body: the message string.
* attributes.log.context: the NestJS logger context (class name), extracted from the last string parameter.
* attributes.exception.stacktrace: for error/fatal only, extracted from the first string parameter when multiple params are present.

Wired in via main.ts: NestFactory.create(AppModule, { logger: new OtelLogger() }).
This overrides the static Logger instance so all existing `new Logger('...')` calls throughout the codebase automatically emit to OTel without any per-file changes.
