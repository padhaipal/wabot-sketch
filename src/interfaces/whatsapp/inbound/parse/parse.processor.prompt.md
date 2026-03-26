1.) Start span
2.) Check data shape against parse.dto.ts
* If data shape check fails then log ERROR and fail the job. 
3.) Loop over entry[]
* If entry[].id does not equal WHATSAPP_BUSINESS_ACCOUNT_ID (this is a .env variable) then skip to the next array element.
* Else continue.
4.) Flatten `entry[].changes[]`
* If `.changes[].value` doesn't have a key `'messages'`, `'statuses'` or `'errors'` then skip it. 
* If `.changes[].value.messages` exists then check it's data shape against src/interfaces/whatsapp/inbound/process/message/message.dto.ts and/or src/interfaces/whatsapp/inbound/process/message/message.dto.prompt.md.
* If `.changes[].value.statuses` exists then check it's data shape against src/interfaces/whatsapp/inbound/process/status/status.dto.ts and/or src/interfaces/whatsapp/inbound/process/status/status.dto.prompt.md.
* If `.changes[].value.errors` exists then check it's data shape against src/interfaces/whatsapp/inbound/process/error/error.dto.ts and/or src/interfaces/whatsapp/inbound/process/error/error.dto.prompt.md.
5.) Build three arrays of process jobs: one for messages, one for statuses and one for errors.
6.) call three `queue.addBulk(jobs)`: messages go to `process-message` queue, statuses go to `process-status` queue and errors go to `process-errors` queue. 
* If the message bulk add fails then log a WARN and retry with exponential backoff with a max time cap of 10s. 
  * If max time cap is reached then log an ERROR, end the span and fail the job. 
* If the status or error bulk add fails then log a WARN and retry with exponential backoff with a max time cap of 24 hours. 
  * If max time cap is reached then log an ERROR, end the span and fail the job. 
* Else log an INFO, end the span and complete the job.

Observability
* Log WARN when WHATSAPP_BUSINESS_ACCOUNT_ID is not set.
* Log WARN when a message fails MessageJobDto validation (includes the raw keys for debugging).
* Set span attributes: parse.message_count, parse.status_count, parse.error_count.
* Set span error status and record exception on failures.
