All endpoints in this controller are protected by InternalApiKeyGuard (src/validation/internal-api-key.guard.ts).
The guard checks the `x-api-key` header against `INTERNAL_API_KEY` env var using timing-safe comparison. Returns 401 if missing/invalid.

sendMessage()
1.) Validate the request body against `SendMessageDto` from inbound.dto.ts.
* If validation fails then return a 400 response.
2.) Extract the OTel carrier from the request body and start a span.
3.) Call src/interfaces/whatsapp/outbound/outbound.service.ts/sendMessage() with:
  * user_id: body.user_external_id
  * wamid: body.wamid
  * consecutive: body.consecutive
  * media: body.media (the ordered array of OutboundMediaItemDto)
4.) sendMessage() returns either:
  * 200 `{ delivered: true }` — all messages were sent to WhatsApp.
  * 200 `{ delivered: false, reason: "inflight-expired" }` — inflight window expired, fallback was already sent.
  * 4XX/5XX — WhatsApp error (passed through as-is).
5.) End the span.

downloadMedia()
1.) Check the http request body against src/interfaces/pp/inbound/inbound.dto.ts DownloadMediaDto.
* If the check fails then return a 400 response.
2.) Extract the OTel carrier from the request body and start a span.
3.) Call src/interfaces/whatsapp/outbound/outbound.service.ts/downloadMedia(body.media_url).
4.) Set the response content-type header to the returned content_type. Pipe the returned readable stream directly into the HTTP response body.
5.) End the span when the stream finishes.
* If downloadMedia() throws or the stream errors: log WARN, end the span and return the correct status.

uploadMedia()
1.) Read the raw binary request body as a Buffer.
2.) Read the Content-Type header (media mime type, e.g. "audio/mpeg") and X-Media-Type header (WhatsApp media type: "audio", "video", or "image").
    * If either header is missing: return a 400 response.
3.) Extract the OTel carrier from the ?otel= query param (JSON-parsed) and start a span.
4.) Call src/interfaces/whatsapp/outbound/outbound.service.ts/uploadMedia(buffer, content_type, media_type).
5.) On success: return 200 with JSON body { wa_media_url: <returned media ID> }. End the span.
* If whatsapp returns a 4XX or 5XX log the error and pass the status through to the caller. End the span.
