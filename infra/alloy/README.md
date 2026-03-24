# Alloy on Railway

This folder contains the Docker build context for running Grafana Alloy as the internal OTLP collector for `wabot`.

## Files

- `config.alloy`: Alloy pipeline (receiver -> processors -> exporter to Grafana Cloud)
- `Dockerfile`: Builds an Alloy container with `config.alloy` at `/etc/alloy/config.alloy`

## Railway Setup

1. Create a new Railway service from this folder (`wabot-sketch/infra/alloy`).
2. Add these environment variables to the Alloy service:
   - `GRAFANA_CLOUD_OTLP_ENDPOINT`
   - `GRAFANA_CLOUD_INSTANCE_ID`
   - `GRAFANA_CLOUD_API_TOKEN`
3. Deploy.
4. In the `wabot` service, set:
   - `OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.railway.internal:4318`
   - `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
   - `OTEL_TRACES_EXPORTER=otlp`
   - `OTEL_METRICS_EXPORTER=otlp`
   - `OTEL_LOGS_EXPORTER=otlp`
   - `OTEL_SERVICE_NAME=wabot`

## Security note

Do not hardcode Grafana Cloud tokens into source files.
Use Railway environment variables only.
