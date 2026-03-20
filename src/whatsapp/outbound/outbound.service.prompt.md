sendReadAndTypingIndicator()

sendMessage(user_id: string, wamid: string, consecutive: boolean | undefined, media: OutboundMediaItemDto[])

Sends an ordered list of media items to a student via the WhatsApp Cloud API. Each item becomes a separate WhatsApp API call, sent sequentially in the order provided.

* If the message is flagged as consecutive then skip the Redis inflight check — go straight to sending the messages to WhatsApp and return the result using the `{ delivered: true/false }` shape.
* Otherwise, attempt the following two DEL commands atomically with a Lua script:
  `DEL "{wabot:${ENV}}:inflight:user-id:<user_id>:wamid:<wamid>"` and 
  `DEL "{wabot:${ENV}}:consecutive-check:user-id:<user_id>"`
	* If the Lua command succeeds (ie both DEL commands return 1) then send the messages to WhatsApp (see below).
	* If the Lua command fails (ie both DEL commands return 0) then log INFO and return 200 with body `{ delivered: false, reason: "inflight-expired" }`. The inflight window was consumed by the timeout job, meaning the fallback message was already sent to the student.

Sending messages to WhatsApp:
* Iterate over the `media` array in order. For each item, send one WhatsApp Cloud API message:
  * `type: 'text'` → POST message with `type: "text"`, `text: { body: item.body }`.
  * `type: 'audio'` → POST message with `type: "audio"`, `audio: { link: item.url }`.
  * `type: 'video'` → POST message with `type: "video"`, `video: { link: item.url }`.
  * `type: 'image'` → POST message with `type: "image"`, `image: { link: item.url }`.
  * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
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
