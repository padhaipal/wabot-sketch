sendReadAndTypingIndicator(wamid: string): Promise<void>
WHATSAPP_ACCESS_TOKEN and PHONE_NUMBER_ID are available in .env.
Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read
Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
* POST to https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages with JSON body:
  {
    "messaging_product": "whatsapp",
    "status": "read",
    "message_id": wamid,
    "typing_indicator": { "type": "text" }
  }
  Headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
* This single call both marks the message as read (blue ticks) and displays a typing indicator to the user. The typing indicator is automatically dismissed when a message is sent, or after 25 seconds, whichever comes first.
* On 2XX: return (caller logs the result).
* On 4XX or 5XX: throw (caller logs the result).

sendMessage(user_id: string, wamid: string, consecutive: boolean | undefined, media: OutboundMediaItemDto[])
WHATSAPP_ACCESS_TOKEN and PHONE_NUMBER_ID are available in .env.
Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages

Sends an ordered list of media items to a student via the WhatsApp Cloud API. Each item becomes a separate WhatsApp API call, sent sequentially in the order provided.

* If the message is flagged as consecutive then skip the Redis inflight check — go straight to sending the messages to WhatsApp and return the result using the `{ delivered: true/false }` shape.
* Otherwise, attempt the following two DEL commands atomically with a Lua script:
  `DEL "{wabot:${ENV}}:inflight:user-id:<user_id>:wamid:<wamid>"` and 
  `DEL "{wabot:${ENV}}:consecutive-check:user-id:<user_id>"`
	* If the Lua command succeeds (ie both DEL commands return 1) then send the messages to WhatsApp (see below).
	* If the Lua command fails (ie both DEL commands return 0) then log INFO and return 200 with body `{ delivered: false, reason: "inflight-expired" }`. The inflight window was consumed by the timeout job, meaning the fallback message was already sent to the student.

Sending messages to WhatsApp:
* Iterate over the `media` array in order. For each item, POST to https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages with headers { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }. Wait for the HTTP response before sending the next item.
  * `type: 'text'` → body: `{ messaging_product: "whatsapp", recipient_type: "individual", to: user_id, type: "text", text: { body: item.body } }`.
  * `type: 'audio'` → body: `{ messaging_product: "whatsapp", recipient_type: "individual", to: user_id, type: "audio", audio: <media_object> }`.
  * `type: 'video'` → body: `{ messaging_product: "whatsapp", recipient_type: "individual", to: user_id, type: "video", video: <media_object> }`.
  * `type: 'image'` → body: `{ messaging_product: "whatsapp", recipient_type: "individual", to: user_id, type: "image", image: <media_object> }`.
  * <media_object> resolution:
    - If item.url starts with "http": use `{ link: item.url }` (external URL).
    - Otherwise: treat item.url as a WhatsApp media ID and use `{ id: item.url }` (preloaded media).
* WhatsApp returns on success: `{ messaging_product: "whatsapp", contacts: [{ input, wa_id }], messages: [{ id, message_status }] }`.
* If WhatsApp returns 2XX for all items then log INFO and return 200 with body `{ delivered: true }`.
* If WhatsApp returns 4XX for any item then log ERROR and return that 4XX status immediately (do not send remaining items).
* If WhatsApp returns 5XX for any item then retry that item with exponential backoff, max time cap of 5s.
  * If max time cap is reached then log ERROR and return the 5XX status (do not send remaining items).

downloadMedia(media_url: string): Promise<{ stream: NodeJS.ReadableStream, content_type: string }>
WHATSAPP_ACCESS_TOKEN is available in .env.
Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
* GET media_url with header { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` }.
* On 2XX: return { stream: response body as a readable stream, content_type: response content-type header value }.
* On 404: log WARN and throw. Media URL has likely expired (URLs are valid for 5 minutes after the webhook fires).
* On other non-2XX: log WARN and throw.

uploadMedia(data: Buffer, content_type: string, media_type: string): Promise<{ wa_media_url: string }>
WHATSAPP_ACCESS_TOKEN and PHONE_NUMBER_ID are available in .env.
Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#upload-media
* POST to https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media with multipart/form-data:
  - file: the raw bytes (Buffer) with filename derived from media_type (e.g. "upload.mp3", "upload.mp4")
  - type: content_type (e.g. "audio/mpeg", "video/mp4")
  - messaging_product: "whatsapp"
  Headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
* On 2XX: extract id from response JSON `{ id: "<MEDIA_ID>" }`. Return { wa_media_url: id }.
  The returned id is a WhatsApp media ID valid for 30 days. It can be used in sendMessage via { id: <value> }.
* On 4XX: log ERROR and throw.
* On 5XX: log WARN and throw.
