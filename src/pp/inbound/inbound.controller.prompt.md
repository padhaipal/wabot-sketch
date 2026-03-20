sendMessage()
1.) Validate the request body against `SendMessageDto` from inbound.dto.ts.
* If validation fails then return a 400 response.
2.) Extract the OTel carrier from the request body and start a span.
3.) Call src/whatsapp/outbound/outbound.service.ts/sendMessage() with:
  * user_id: body.user_external_id
  * wamid: body.wamid
  * consecutive: body.consecutive
  * media: body.media (the ordered array of OutboundMediaItemDto)
4.) Return to pp whatever sendMessage() returns and end the span. sendMessage() returns either:
  * 200 `{ delivered: true }` — all messages were sent to WhatsApp.
  * 200 `{ delivered: false, reason: "inflight-expired" }` — inflight window expired, fallback was already sent.
  * 4XX/5XX — WhatsApp error (passed through as-is).

downloadMedia()
1.) Check the http request body against src/pp/inbound/inbound.dto.ts DownloadMediaDto.
* If the check fails then return a 400 response.
2.) Extract the OTel carrier from the request body and start a span.
3.) Call src/whatsapp/outbound/outbound.service.ts/downloadMedia(body.media_url).
4.) Set the response content-type header to the returned content_type. Pipe the returned readable stream directly into the HTTP response body.
5.) End the span when the stream finishes.
* If downloadMedia() throws or the stream errors: log WARN, end the span and return 502.
