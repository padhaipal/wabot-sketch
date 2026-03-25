Dependencies: @opentelemetry/api (context, propagation, trace).
Inject AcceptService via constructor.
Create a tracer via trace.getTracer('accept-controller') as a private readonly class property.

0.) GET /webhook — Webhook verification handshake.
   * Read query parameters: hub.mode, hub.verify_token, hub.challenge.
   * If hub.mode === 'subscribe' AND hub.verify_token matches WHATSAPP_VERIFY_TOKEN env var, respond 200 with hub.challenge as plain text.
   * Else respond 403.

1.) POST /webhook — Receive webhook events (async, returns Promise<void>).
   * Validate rawBody exists (Buffer.isBuffer). If not, return 401.
   * Validate X-Hub-Signature-256 via accept.service.ts/isValidSignature(). If invalid, return 401.
   * Create a child span via this.tracer.startSpan('enqueue-ingest').
   * Inside a try/finally (span.end() in finally):
     * Build the active context with the child span via trace.setSpan(context.active(), span).
     * Create an empty carrier Record<string, string> and inject W3C trace context into it via propagation.inject(ctx, carrier). This carrier is passed into the BullMQ job so downstream workers continue the distributed trace.
     * Call await this.acceptService.receiveWebhook(body, carrier) which returns an HTTP status number (200 or 500).
     * Send that status as the HTTP response to WhatsApp.