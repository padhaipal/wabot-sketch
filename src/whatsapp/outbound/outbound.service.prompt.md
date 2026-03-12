sendReadAndTypingIndicator()

sendMessage(user_id, wamid, consecutive-flag, message formatting)
* If the message is flagged as responding to a consecutive message then it is sent and the https response status is returned.
* Otherwise it attempts the following two commands atomically with a Lua command
  `DEL "{wabot:${ENV}}:inflight:user-id:<user_id>:wamid:<wamid>"` and 
  `DEL "{wabot:${ENV}}:consecutive-check:user-id:<user_id>"`
	* if the Lua command succeeds (ie both DEL commands return 1) then it will send the message to WhatsApp.
    * if WhatsApp returns 2XX then log INFO and return that status. 
    * if WhatsApp returns 4XX then log ERROR and return that status.
    * if WhatsApp returns 5XX then log WARN then exponential fallback with a max time cap of 5s.
      * if max time cap is reached then log an ERROR and return the 5XX status
	* if the Lua command fails (ie both DEL commands return 0) then an INFO is logged and the function returns. 

downloadMedia(media_url: string): Promise<{ stream: NodeJS.ReadableStream, content_type: string }>
WHATSAPP_ACCESS_TOKEN is available in .env.
Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
* GET media_url with header { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` }.
* On 2XX: return { stream: response body as a readable stream, content_type: response content-type header value }.
* On 404: log WARN and throw. Media URL has likely expired (URLs are valid for 5 minutes after the webhook fires).
* On other non-2XX: log WARN and throw.
