0.) Start a span
1.) I will dedupe messages by attempting to write the message's wamid (WhatsApp media id) to the dedupe namespace with `SET mykey "{wabot:${ENV}}:dedupe:wamid:<wamid>" NX`. The `NX` means if the key already exists don't override it but instead return `nil`. Make the TTL 7 days. Record metrics about dedupe hits and misses using code similar to that below. 
* If the call to Redis fails then log a WARN and do exponential backoff with a 10 second cap logging a WARN for every failed attempt.
  * If the backoff cap is reached then log an ERROR and terminate the job. 
* If `nil` is returned then skip over this message (it is a duplicate).
* Else continue

import { initMetrics } from '../otel/metrics';

const meter = initMetrics();

export const dedupeHits = meter.createCounter('wabot_dedupe_hits_total');
export const dedupeMisses = meter.createCounter('wabot_dedupe_misses_total');
export const jobDurationMs = meter.createHistogram('wabot_job_duration_ms');

dedupeHits.add(1, { stage: 'wa_handle_ingest', jobName: 'process:message' });
jobDurationMs.record(durationMs, { queue: 'process', jobName: 'message', outcome: 'success' });


2.) I will send a typing indicator to the user.
* If I get a 429/5XX response then log/metrics/span metadata a WARN and do exponential backoff for 10s. 
  * If I reach the backoff max time cap then log/metrics/span metadata a WARN and continue to step 3. 
* If I get a 4XX response then log/metric/trace metadata a WARN and continue to step 3. (It is a WARN and not an ERROR because we can continue to respond to the user). 
* If I get a 2XX response then continue.
3.) I will then detect consecutive messages from the user by using the user’s wa_id in the following command
	  `SCAN 0 MATCH "{wabot:${ENV}}:inflight:wa_id:<wa_id>:wamid:*" COUNT 1`
	  This will return an object like consecutiveMessages = ["<nextCursor>", ["<key1>", "<key2>", "..."]]
* If the call to Redis fails then log a WARN and do exponential backoff with a 10 second cap logging a WARN for every failed attempt.
  * If the backoff cap is reached then log/metric/trace metadata an ERROR. 
  * Use the FALLBACK_VIDEO_URL in wabot.env and the user’s phone number in the json to send a “Sorry, I couldn’t process that message. Please try again. If it keeps failing, it’s okay to come back tomorrow.” default message.Note that sending this message will reset the counter for consecutive messages.Also note that this the same code as above. 
    * If I get a 2XX response then log/metric/trace metadata an INFO and end the worker and span.
    * If I get a 429/5XX response then log/metrics/span metadata a WARN and do exponential backoff for up to 25s after the timestamp in the user’s sent message. 
      * If I reach the backoff max time cap then log/metrics/span metadata a WARN, mark this job something that will get BullMQ to try again with it’s exponential backoff and terminate the worker/span. 
    * If I get a 4XX response then log/metric/trace metadata an ERROR. Mark the job as failed so BullMQ doesn’t try again. Terminate the worker and span.
* If `consecutiveMessages[1].length` equals zero then PadhaiPal has responded to the last user's message that the WhatsApp bot has received. I need to create the redis key `{wabot:${ENV}}:inflight:wa_id:<wa_id>:wamid:<wamid>` and then proceed as normal. 
  * If the call to Redis fails then log a WARN, capture this in metrics, attach relevant information in the span metadata and do exponential backoff with a 10 second cap logging a WARN for every failed attempt.
    * If the backoff cap is reached then log an ERROR.
      * Use the FALLBACK_VIDEO_URL in wabot.env and the user’s phone number in the json to send a “Sorry, I couldn’t process that message. Please try again. If it keeps failing, it’s okay to come back tomorrow.” default message.Note that sending this message will reset the counter for consecutive messages.Also note that this the same code as above. 
        * If I get a 2XX response then log/metric/trace metadata an INFO and end the worker and span.
        * If I get a 429/5XX response then log/metrics/span metadata a WARN and do exponential backoff for up to 25s after the timestamp in the user’s sent message. 
          * If I reach the backoff max time cap then log/metrics/span metadata a WARN, mark this job something that will get BullMQ to try again with it’s exponential backoff and terminate the worker/span. 
        * If I get a 4XX response then log/metric/trace metadata an ERROR. Mark the job as failed so BullMQ doesn’t try again. Terminate the worker and span.
* If `consecutiveMessages[1].length` does not equal zero then PadhaiPal is still processing the user's last message that the WhatsApp bot has received. Still send this message to PadhaiPal (by proceeding as normal by creating a wa-process-message job) but attach a flag to it that it is a consecutive message. (PadhaiPal will probably run a random function that gives a 20% chance of success. Upon success it will send the user a message saying 'Please wait until PadhaiPal has finished thinking'. 
4.) For every message that gets this far the important information is extracted into a JSON object (wamid, an id that can identify the user (wa_id?), timestamp, type, consecutive status and optionally the media_id). Then send this data to pp in a http request hitting the !!! endpoint. In normal flow PadhaiPal will send a quick 2XX response and then process the request asynchronously. Upon receiving the 2XX response end the worker and the span. (Note the user’s audio isn’t downloaded in this step. If pp wants it, it can request it). 
* If the call to PadhaiPal fails to get a response within 20s of when the user sent the message then log/metrics/trace metadata a WARN. The reason no retry is attempted is because to do this I would need to add dedupe and rollback functionality in pp for limited benefit. 
  * Use the FALLBACK_VIDEO_URL in wabot.env and the user’s phone number in the json to send a “Sorry, I couldn’t process that message. Please try again. If it keeps failing, it’s okay to come back tomorrow.” default message.
    * If I get a 2XX response then log/metric/trace metadata an INFO and end the worker and span.
    * If I get a 429/5XX response then log/metrics/span metadata a WARN and do exponential backoff for up to 25s after the timestamp in the user’s sent message. 
      * If I reach the backoff max time cap then log/metrics/span metadata a WARN, mark this job something that will get BullMQ to try again with it’s exponential backoff and terminate the worker/span. 
    * If I get a 4XX response then log/metric/trace metadata an ERROR. Mark the job as failed so BullMQ doesn’t try again. Terminate the worker and span.
  * If the call to PadhaiPal is a 5XX, a 408, a 425 or a 429 response then log/metric/trace metadata a WARN, capture this in metrics, attach relevant information in the span metadata and do exponential backoff with a 10 second cap.
    * If the backoff cap is reached then log/metric/trace metadata an ERROR and terminate the job. (Note I think this is wrong because pp assumes no duplicate messages which is what this seems to be. 
    * Use the FALLBACK_VIDEO_URL in wabot.env and the user’s phone number in the json to send a “Sorry, I couldn’t process that message. Please try again. If it keeps failing, it’s okay to come back tomorrow.” default message.Note that sending this message will reset the counter for consecutive messages.Also note that this the same code as above. 
      * If I get a 2XX response then log/metric/trace metadata an INFO and end the worker and span.
      * If I get a 429/5XX response then log/metrics/span metadata a WARN and do exponential backoff for up to 25s after the timestamp in the user’s sent message. 
        * If I reach the backoff max time cap then log/metrics/span metadata a WARN, mark this job something that will get BullMQ to try again with it’s exponential backoff and terminate the worker/span. 
      * If I get a 4XX response then log/metric/trace metadata an ERROR. Mark the job as failed so BullMQ doesn’t try again. Terminate the worker and span.
  * If the call to PadhaiPal is a different 4XX or 3XX response then log an ERROR, capture this in metrics, attach relevant information in the span metadata.
    * Use the FALLBACK_VIDEO_URL in wabot.env and the user’s phone number in the json to send a “Sorry, I couldn’t process that message. Please try again tomorrow.” default message.Note that sending this message will reset the counter for consecutive messages.Also note that this the same code as above. 
      * If I get a 2XX response then log/metric/trace metadata an INFO and end the worker and span.
      * If I get a 429/5XX response then log/metrics/span metadata a WARN and do exponential backoff for up to 25s after the timestamp in the user’s sent message. 
        * If I reach the backoff max time cap then log/metrics/span metadata a WARN, mark this job something that will get BullMQ to try again with it’s exponential backoff and terminate the worker/span. 
      * If I get a 4XX response then log/metric/trace metadata an ERROR. Mark the job as failed so BullMQ doesn’t try again. Terminate the worker and span.
Notes
* We don’t retry in step four, partially because we need to respond quickly to the user and retries would add latency. But mainly because wabot has deduped messages. If wabot sends retries to pp then pp will also have to dedupe messages which adds unnecessary complexity and potential failure modes to the codebase. Also both wabot and pp are hosted in the same railway project and so the network should be far more reliable than sending messages across the wider internet network. 








A suggested datashape to pass into PadhaiPal
{
  "userId": "<WHATSAPP_USER_PHONE_NUMBER>",
  "messageId": "<WHATSAPP_MESSAGE_ID>",
  "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
  "type": "XXX",
  "mediaURL": "<MEDIA_ASSET_URL>", // Optional (text messages won't have this. 
  "textBody": "<MESSAGE_TEXT_BODY>",
  "errors": [ // Optional
    {
      "code": 131051,
      "title": "Message type unknown",
      "message": "Message type unknown",
      "error_data": {
        "details": "Message type is currently not supported."
      }
    }
  ]
}
