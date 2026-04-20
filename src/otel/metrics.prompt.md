SLO metric for the 25-second message response target (see docs/observability.md).

wabot.message.e2e_duration_ms (Histogram)
* Attributes: outcome (see below for the full value set).
* Value: Date.now() − (message.timestamp × 1000), i.e. milliseconds from the original
  WhatsApp message timestamp to the recording point.

Two recording sites emit this metric using disjoint `outcome` values so a dashboard
can filter by stage without relabeling anything:

1.) Handoff / control-plane stage — recorded at the end of processMessage in
    src/interfaces/whatsapp/inbound/process/message/message.processor.ts.
    * outcome = "success" — wabot successfully handed the message off to pp-sketch
      (pp-sketch returned 2XX for the inbound enqueue). This is a handoff latency,
      NOT a user delivery latency — pp-sketch returns 202 before it processes the
      message.
    * outcome = "fallback" — wabot sent (or attempted to send) the fallback video
      because dedupe / consecutive-check / pp-sketch failed. The actual sendMessage
      delivery recording for the fallback happens in the site below with a distinct
      outcome value; this "fallback" recording is the control-plane signal that we
      bailed out of the normal path.

2.) User-perceived delivery stage — recorded at each return point of
    src/interfaces/whatsapp/outbound/outbound.service.ts/sendMessage(). This captures
    the full latency from the WhatsApp message timestamp to the moment wabot either
    finishes sending to the WhatsApp Cloud API, decides not to send (inflight
    expired), or bails out on a WhatsApp error. To access the original timestamp
    without threading it through DTOs, sendMessage reads it from W3C Baggage entry
    `wabot.msg.ts_ms` on `context.active()`.
    * outcome = "delivered" — every media item was sent to WhatsApp and returned 2XX.
    * outcome = "inflight-expired" — the inflight window closed before sendMessage
      ran (either the benign race where the timeout path already delivered, or the
      bug path where the keys were never set). sendMessage returns
      { delivered: false, reason: "inflight-expired" }.
    * outcome = "whatsapp-error" — WhatsApp returned 4XX or 5XX (5XX after retries
      were exhausted). sendMessage returns
      { delivered: false, reason: "whatsapp-error" }.

W3C Baggage contract for the delivery stage:
* `wabot.msg.ts_ms` (string-encoded integer) — original message timestamp in
  milliseconds. Required for delivery-stage recording.
* `wabot.msg.wamid` (string) — WhatsApp message id. Set for symmetry / future use;
  not yet consumed by the outbound metric but useful in logs.

Baggage propagation chain (source of truth: processMessage → pp-sketch → back to wabot):
1. processMessage sets `wabot.msg.ts_ms` and `wabot.msg.wamid` on `ctxWithBaggage`
   right after parsing the WhatsApp payload, then uses `ctxWithBaggage` for BOTH
   `propagation.inject(ctxWithBaggage, carrier)` (carrier to pp-sketch AND to the
   timeout queue job) AND for every call to `sendFallback({ ..., ctx: ctxWithBaggage })`.
2. sendFallback wraps `waOutbound.sendMessage` in `context.with(opts.ctx, () => ...)`
   so `context.active()` inside sendMessage returns ctxWithBaggage.
3. processMessageTimeout extracts the carrier from the job payload into parentCtx
   (which already contains the baggage because processMessage injected with
   ctxWithBaggage), attaches the new span via `trace.setSpan(parentCtx, span)`, and
   wraps `waOutbound.sendMessage` in `context.with(ctx, () => ...)`.
4. PpInboundController.sendMessage (wabot) extracts the carrier from its HTTP body
   (pp-sketch sends `injectCarrierFromContext(ctx)` on the return leg, preserving
   baggage), attaches the new span, and already wraps `waOutbound.sendMessage` in
   `context.with(ctx, () => ...)`. No changes needed there beyond pp-sketch's
   switch to the baggage-preserving OTel helpers.

Self-monitoring:
* If sendMessage's `context.active()` has no `wabot.msg.ts_ms` baggage, it logs a
  WARN ("Missing wabot.msg.ts_ms baggage in sendMessage for user ..., wamid=...")
  and skips the delivery-stage recording. Persistent WARN volume here means the
  propagation chain above is broken somewhere.
