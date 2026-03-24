1.) Ensure the parameter data type is correct.
2.) isValidSignature(signatureHeader, rawBody) → boolean.
   * Validate the X-Hub-Signature-256 using the raw https body and the META_APP_SECRET environment variable stored in .env.
   * If validation fails then Log a WARN and return false.
   * Else return true.
   * May delegate to existing private validateSignature() if present.

3.) logDecryptedPayload(body: unknown) → void.
   * After signature validation succeeds, log the full decrypted webhook JSON payload using Logger.log() so it appears in Railway runtime logs.
   * Format: JSON.stringify the body with 2-space indentation for readability.
   * Prefix the log line with "Decrypted webhook payload:" so it is easy to find in Railway logs.
   * Note: OTel auto-instrumentation (src/otel/otel.ts) automatically correlates these NestJS Logger calls with the active trace/span context. No manual trace injection needed in log statements.

Future (requires Redis/BullMQ — not yet implemented):
4.) receiveWebhook(body, otelCarrier) — Enqueue `webhook` job on `ingest` queue.
   * The otelCarrier (Record<string, string>) is the W3C trace context extracted from the active span by the controller. It is included in the job payload so downstream BullMQ workers can continue the distributed trace.
   * Note: to obtain the required data structure, view src/interfaces/whatsapp/inbound/parse/parse.dto.ts and src/interfaces/whatsapp/inbound/parse/parse.processor.prompt.md.
   * If enqueue fails then retry with backoff with a max time cap of 10s.
     * If max time cap is reached then Log an ERROR, return HTTPS 500 status and terminate the method.
   * Else: return 2XX and terminate the method.