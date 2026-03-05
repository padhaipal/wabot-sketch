BullMQ Queue & Worker Configuration

Shared
- Redis connection: AOF-enabled Redis instance.
- Key prefix: `{wabot:${ENV}}:bullmq`. The curly braces are Redis Cluster hash tags ensuring all BullMQ keys for a given environment land on the same Redis node.

`ingest` queue
- Job names: `webhook`
- Producer: wa-handle-ingress.service.ts
- Consumer: wa-message-ingest.processor.ts
- Worker concurrency: 3
  Each ingest job parses one webhook payload and fans out individual items to the `process` queue. This is fast (sub-second), mostly CPU-bound parsing with brief Redis writes. Low concurrency is sufficient for MVP volume.
- Attempts: 1 (no BullMQ-level retries)
  If the job fails with an uncaught exception, don't retry. The 200 has already been returned to WhatsApp so the webhook won't be resent. The ingest processor handles per-item failures internally with its own exponential backoff.
- Stalled job interval: 30000ms (30s)
- Max stalled count: 1
  An ingest job should complete in under 5s. If it stalls, mark it failed.
- Remove on complete: { count: 1000 }
  Keep the last 1000 completed jobs for debugging visibility.
- Remove on fail: false
  Keep all failed jobs for investigation.

`process` queue
- Job names: `message`, `status`, `error`
- Producer: wa-message-ingest.processor.ts
- Consumer: wa-message-process.processor.ts
- Worker concurrency: 10
  Process jobs are I/O-bound (Redis lookups, HTTP to WhatsApp API for typing indicators/fallback messages, HTTP to PadhaiPal). Higher concurrency than ingest to avoid head-of-line blocking when one job is waiting on a network response.
- Attempts: 1 (no BullMQ-level retries)
  All handlers manage their own retry logic internally and explicitly mark jobs as failed on exhaustion. BullMQ-level retries are not used to avoid needing deduplication in downstream services.
- Stalled job interval: 30000ms (30s)
- Max stalled count: 1
  A process job should complete within 25s (the time budget is anchored to the user's message timestamp). If it stalls, mark it failed.
- Remove on complete: { count: 1000 }
- Remove on fail: false

Notes
- Rate limiting: Not configured for MVP. If WhatsApp webhook volume grows, consider BullMQ's built-in rate limiter on the process queue to stay within WhatsApp Cloud API rate limits (80 messages/second for business accounts).
- Concurrency values are starting points. Monitor the `wabot_job_duration_ms` histogram and adjust. If jobs are mostly waiting on I/O, concurrency can increase. If Redis or PadhaiPal becomes a bottleneck, decrease.
- Scaling: Both workers run in the same process for MVP. If the process queue becomes a bottleneck, it can be scaled horizontally by running additional worker instances — BullMQ handles distributed locking.
