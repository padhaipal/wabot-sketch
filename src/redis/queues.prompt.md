// wabot-sketch/src/redis/queues.prompt.md

Export queue names, Redis connection, and Queue/Worker factories.

1.) QUEUE_NAMES constant.
* INGEST, PROCESS_MESSAGE, PROCESS_STATUS, PROCESS_ERRORS, PROCESS_MESSAGE_TIMEOUT.
* See src/docs/bullmq.md for pipeline and per-queue settings.

2.) Redis connection.
* Create ioredis Connection from REDIS_URL (.env).
* Use for BullMQ Queue and Worker instances.

3.) createQueue(name, defaultJobOptions?).
* Returns BullMQ Queue instance.
* Used by producers: accept.service (ingest), parse.processor (process-*), message.processor (process-message-timeout).

4.) createWorker(name, processor, defaultJobOptions?).
* Returns BullMQ Worker instance.
* Workers must be started on app bootstrap (see main.prompt.md).
* Used by: ingest → parse.processor; process-message → message.processor; process-status → status.processor; process-errors → error.processor; process-message-timeout → message.processor.

5.) Redis key prefix.
* All keys use `{wabot:${ENV}}:` for cluster hash-tag. ENV from .env.
