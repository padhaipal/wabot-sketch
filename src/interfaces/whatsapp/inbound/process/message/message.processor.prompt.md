1.) Start span
2.) Check data shape against message.dto.ts.
* If data shape check fails then log ERROR and mark the job as failed.
3.) Dedupe message TTL 7 days. This is done by attempting to write the message's wamid (WhatsApp message id) to the dedupe namespace in redis with `SET "{wabot:${ENV}}:dedupe:wamid:<wamid>" 1 NX`. The `NX` means if the key already exists don't override it but instead return `nil`.
* See notes on how to handle non-responsive redis.
* If the message is a duplicate then log an INFO and mark the job as complete.
* Else continue.
4.) (This is completed asynchronously at the same time as step five) Run src/interfaces/whatsapp/outbound/outbound.service.ts/sendReadAndTypingIndicator().
* If 2XX response then log INFO.
* If 4XX or 5XX response log WARN.
5.) (Steps 5+ are completed asynchronously at the same time as step four) Set a BullMQ job on the process-message-timeout queue to execute in message.timestamp+20s amount of time.
* if fail to enqueue then log a WARN and exponentially backoff for 10s.
  * if backoff fails then log an ERROR and fail the job.
6.) Run a Lua command that atomically executes the following
* SET “{wabot:${ENV}}:consecutive-check:user-id:<user_id>” NX EX 25
  * If SET succeeds
  	* SET “{wabot:${ENV}}:inflight:user-id:<user_id>:wamid:<wamid>” EX 25
  	* return non-consecutive flag
  * If SET fails
  	* return consecutive flag
7.) src/interfaces/pp/outbound/outbound.service.ts/sendMessage()
* If 2XX response then log INFO and mark the job as complete.
* If 4XX log ERROR and send fall back message then mark the job as failed.
* If 5XX log ERROR and send fall back message then mark the job as failed.

Notes
* This is what the process-message-timeout job does when it is executed. This code is defined in this file.
  * it runs src/interfaces/whatsapp/outbound/outbound.service.ts/sendMessage() with FALL_BACK_MESSAGE_PUBLIC_URL


* Send fall back message. Call src/interfaces/whatsapp/outbound/outbound.service.ts/sendMessage() with .env variable FALL_BACK_MESSAGE_PUBLIC_URL. This is a public URL (starts with http) pointing to a video or audio file hosted in the wabot-sketch repository. Because it is a public URL (not a preloaded WhatsApp media ID), sendMessage() will use the `{ link: url }` media object form. Infer the WhatsApp media type (audio or video) from the URL file extension. Note that sendMessage() handles retries on 5XX. Wait for response from sendMessage() log that response and complete the job and span.


* Non-responsive redis.
  * If redis is non-responsive then log a WARN and retry with exponential backoff with a maximum time cap of 10s. 
    * If that maximum time cap is reached then log an ERROR and send the fall back message (see notes).
