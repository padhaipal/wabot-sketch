0.) GET /webhook — Webhook verification handshake.
   * Read query parameters: hub.mode, hub.verify_token, hub.challenge.
   * If hub.mode === 'subscribe' AND hub.verify_token matches WHATSAPP_VERIFY_TOKEN env var, respond 200 with hub.challenge as plain text.
   * Else respond 403.

1.) POST /webhook — Receive webhook events.
   * OTel auto-instrumentation (configured in src/otel/otel.ts) automatically creates spans for every inbound HTTP request. No manual span creation is needed at this stage.
   * Validate X-Hub-Signature-256 via accept.service.ts/isValidSignature(). If invalid, return 401.
   * Log the full webhook body as JSON.
   * Extract and log individual messages, statuses, and errors for readability.
   * Return 200 immediately.
   * Do NOT call receiveWebhook() or enqueue to BullMQ — log only for now.

Future (requires Redis/BullMQ — not yet implemented):
2.) Create a child span for webhook processing. Inject the OTel W3C trace context carrier into the BullMQ job payload using @opentelemetry/api propagation, so downstream workers can continue the distributed trace.
3.) Replace logging with accept.service.ts/receiveWebhook() to enqueue jobs.
4.) Return to WhatsApp servers the https status that it receives from accept.service.ts/receiveWebhook().
5.) End the child span.