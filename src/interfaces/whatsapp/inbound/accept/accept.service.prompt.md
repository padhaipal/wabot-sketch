Dependencies: bullmq (Queue type), src/interfaces/redis/queues.ts (createQueue, QUEUE_NAMES).
Private readonly ingestQueue: Queue — created in constructor via createQueue(QUEUE_NAMES.INGEST).

1.) Ensure the parameter data type is correct.
2.) isValidSignature(signatureHeader, rawBody) → boolean.
   * Validate the X-Hub-Signature-256 using the raw https body and the META_APP_SECRET environment variable stored in .env.
   * If validation fails then Log a WARN and return false.
   * Else return true.
   * Delegates to private validateSignature(signatureHeader, rawBody, appSecret).

3.) logDecryptedPayload(body: unknown) → void.
   * Log the full webhook JSON payload using Logger.log() so it appears in Railway runtime logs.
   * Format: JSON.stringify the body with 2-space indentation for readability.
   * Prefix the log line with "Decrypted webhook payload:" so it is easy to find in Railway logs.

4.) async receiveWebhook(body: unknown, otelCarrier: Record<string, string>) → Promise<number>.
   * Enqueue a 'webhook' job on the ingest queue via this.ingestQueue.add('webhook', { otel: { carrier: otelCarrier }, body }).
   * The otelCarrier is the W3C trace context extracted by the controller. It is included in the job payload so downstream BullMQ workers (see parse.processor.prompt.md) can continue the distributed trace.
   * Job data shape: { otel: { carrier: Record<string, string> }, body: unknown }.
   * On success: log INFO "Job enqueued on ingest queue", return 200.
   * On failure: retry with exponential backoff (initial delay 500ms, doubled each attempt, capped at 5 000ms per sleep). Total deadline: 10s from method entry.
     * While remaining time exceeds the next delay, log WARN and sleep then retry.
     * If deadline is reached: log ERROR with the error message and return 500.

5.) private validateSignature(signatureHeader, rawBody, appSecret) → boolean.
   * Check sha256= prefix. If missing, WARN and return false.
   * Extract hex digest. If malformed (not 64 hex chars), WARN and return false.
   * Compute expected HMAC-SHA256 hex digest.
   * Compare expected vs received using timingSafeEqual on Buffer representations. If mismatch, WARN and return false.
   * Else return true.