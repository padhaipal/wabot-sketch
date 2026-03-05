1.) Validate the X-Hub-Signature-256 by using the META_APP_SECRET environment variable stored in .env
If signature is invalid return a 401 and log a WARN. 
Else continue.
2.) Return a 2XX OK HTTPS response and log an INFO. 
3.) Then queue a ingest:webhook job on the wabot:ingest queue with BullMQ using AOF Redis. The job should contain the HTTPS json payload and the trace/span information. (wabot:<env>:bullmq:wabot:ingest:webhook)
* If BullMQ gives confirmation of enqueuing success then stop processing.
* If BullMQ fails confirmation then log a WARN and start exponential backoff retry attempts for 10 seconds.
  * If the max time second cap is hit then log/metrics/trace metadata an ERROR and !!! send a “Sorry, I couldn’t process that message. Please try again. If it keeps failing, it’s okay to come back tomorrow.” !!!
4.) End the worker and span. 

Notes: 
I was initially skeptical of using an in memory datastore for storing queue data but after a conversation with ChatGPT I’m convinced that this is fine. The architects of BullMQ obviously know a lot more about queuing than I do and they came to the same conclusion. 
Returning a 2XX OK response before the deduping step is standard behavior because WhatsApp should know that duplicated messages have been received.
I’m not sure if returning a 2XX OK response before queueing to BullMQ is standard. However, I want control over exponential backoff retry attempts instead of relying on WhatsApp’s policies about it. Because the X-Hub-Signature-256 has been passed I already have the information that WhatsApp is trying to send me so why rely on their retry system rather than my own? 
I am tempted to store the https header and body in a PG database so that complete reproducibility could be achieved but ChatGPT thinks that is a really bad idea and that I can just rely on the traces and logs for reproducibility. I’m still not convinced it is a terrible idea but I also don’t want to have to bother figuring out how to store that data. Plus I’ve never experienced a proper observability system and once I have maybe I’ll understand better why I don’t need it.
The 10 second number will be adjusted based off of metrics to help meet the service level objective of having 99.XX% of messages responded to within 60 seconds over a 24 hour window. Every time we hit Redis, the database or an API call we will have this fallback exponential backoff system in place. We could set this retry window such that even if all of these backoffs succeed just before their capped times and still meet the 60 second limit. However, given how unlikely that is we can instead base the time cap on the metrics we observe will likely achieve the service level objective. This means we don’t give up on retries prematurely.