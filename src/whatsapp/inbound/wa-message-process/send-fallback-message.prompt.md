sendFallbackMessage(wa_id, messageTimestamp)

Use the FALLBACK_VIDEO_URL in wabot.env and the user's wa_id to send a "Sorry, I couldn't process that message. Please try again. If it keeps failing, it's okay to come back tomorrow." default message. Note that sending this message will reset the counter for consecutive messages.
* If I get a 2XX response then log/metric/trace metadata an INFO and end the worker and span.
* If I get a 429/5XX response then log/metrics/span metadata a WARN and do exponential backoff for up to 25s after messageTimestamp.
  * If I reach the backoff max time cap then log/metrics/span metadata an ERROR. Mark the job as failed so BullMQ doesn't try again. Terminate the worker and span.
* If I get a 4XX response then log/metric/trace metadata an ERROR. Mark the job as failed so BullMQ doesn't try again. Terminate the worker and span.
