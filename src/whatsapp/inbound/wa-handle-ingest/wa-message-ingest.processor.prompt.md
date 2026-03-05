1.) Use the trace information to start a new span. The span name will be wabot.ingest, log an INFO.
2.) Structural validation: check that the payload passes the structural validation described in parse-whatsapp-webhook.prompt.md (object, entry, id, changes, field, value). Does NOT check messages/statuses/errors arrays.
* If structural validation fails then log/metrics/trace metadata an ERROR, stop the span and end the job.
* Else log an INFO and continue.
3.) The WhatsApp bot worker will then loop over every `entry` and skips any whose "id" key does not have the correct  WHATSAPP_BUSINESS_ACCOUNT_ID which is recorded in .env. Note that this shouldn't happen. 
3.1.) Then loop over every `changes` inside those entries (entry[x].changes) and ignore any that do not have the `field` key equal to messages, value.messaging_product not equal to "whatsapp". Note that we will only initially subscribe to messages. Overtime we can subscribe to other fields.

3.2.) Then loop over every `messages` (entry[x].changes[x].value.messages ?? []). Per-item validation: each message must have string `from`, `id`, `timestamp`, `type`. If missing, log WARN and skip that message. If valid, enqueue a `message` job on the BullMQ `process` queue with the complete message json and the span/trace information.
* If BullMQ gives enqueuing success confirmation then move to the next loop iteration.
* If queuing fails then log/metrics/trace metadata a WARN and attempt exponential backoff for 10 seconds.
  * If max backoff time cap has been reached then log/metrics/trace metadata an ERROR and move to the next loop iteration.
3.3.) Then loop over every `statuses` (entry[x].changes[x].value.statuses ?? []). Per-item validation: each status must have string `id`, `status`, `recipient_id`. If missing, log WARN and skip that status. If valid, enqueue a `status` job on the BullMQ `process` queue with the complete status json and the span/trace information.
* If BullMQ gives enqueuing success confirmation then move to the next loop iteration.
* If queuing fails then log/metrics/trace metadata a WARN and attempt exponential backoff for 10 seconds.
  * If max backoff time cap has been reached then log/metrics/trace metadata an ERROR and move to the next loop iteration.
3.4.) Then loop over every `errors` (entry[x].changes[x].value.errors ?? []). Per-item validation: each error must have number `code`. If missing, log WARN and skip that error. If valid, enqueue an `error` job on the BullMQ `process` queue with the complete error json and the span/trace information.
* If BullMQ gives enqueuing success confirmation then move to the next loop iteration.
* If queuing fails then log/metrics/trace metadata a WARN and attempt exponential backoff for 10 seconds.
  * If max backoff time cap has been reached then log/metrics/trace metadata an ERROR and move to the next loop iteration.
4.) End the span, log an INFO and end the job.

Notes
A note about step 2. We return 200 to WhatsApp servers even if they send malformed data because we don't want them retrying with the same malformed data. Also we know WhatsApp sent the data malformed rather than it becoming malformed in transit because it passed the X-Hub-Signature. This likely means that WhatsApp has created a non-backwards compatible change in the shape of the data they send. If I don't put this check here something else random would break in the code and I would have to trace it to this cause which could be difficult. Plus it is better for the bot to not work at all than for it to partially work and have to try and undo those changes.
